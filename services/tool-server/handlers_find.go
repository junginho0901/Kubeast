// k8s_find_resource looks for objects by a name fragment or a label across
// several kinds and namespaces, so the model does not guess namespaces one
// kubectl get at a time. k8s_explain hands the model the API schema
// (kubectl explain) so it stops inventing field names.

package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

var findDefaultKinds = []string{"pods", "deployments", "statefulsets", "daemonsets", "services", "ingresses", "configmaps", "jobs", "cronjobs"}

const (
	findMaxKinds   = 12
	findMaxMatches = 50
	// explainMaxBytes caps kubectl explain --recursive, which can run to hundreds of KB.
	explainMaxBytes = 64 << 10
)

func handleFindResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	query := strings.TrimSpace(argString(args, "query", ""))
	if query == "" {
		return "", wrapBadRequest("query parameter is required")
	}
	kinds := argStringSlice(args, "kinds")
	if len(kinds) == 0 {
		kinds = findDefaultKinds
	}
	if len(kinds) > findMaxKinds {
		return "", wrapBadRequest(fmt.Sprintf("kinds: at most %d kinds per call", findMaxKinds))
	}
	namespace := argString(args, "namespace", "")
	limit := argInt(args, "limit", 20)
	if limit <= 0 {
		limit = 20
	}
	if limit > findMaxMatches {
		limit = findMaxMatches
	}

	// A namespace-scoped grant searches only its namespaces; the gate has
	// already refused a namespace outside them.
	namespaces := scopedNamespaces(ctx)
	if namespace != "" {
		namespaces = []string{namespace}
	}
	var searched interface{} = "all namespaces"
	if len(namespaces) > 0 {
		searched = namespaces
	}

	labelKey, labelValue, byLabel := strings.Cut(query, "=")
	needle := strings.ToLower(query)
	matches := make([]map[string]string, 0, limit)
	notes := []string{}
	truncated := false
	for _, kind := range kinds {
		if truncated {
			break
		}
		for _, ns := range nsTargets(namespaces) {
			cmd := []string{"get", kind}
			cmd = append(cmd, ns...)
			cmd = append(cmd, "-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,LABELS:.metadata.labels", "--no-headers")
			text, err := runKubectl(ctx, headers, cmd...)
			if err != nil {
				if f, ok := classifyKubectlFailure(err); ok && f.Status == "unknown_kind" {
					notes = append(notes, fmt.Sprintf("kind %q is not served by this cluster", kind))
				} else {
					notes = append(notes, fmt.Sprintf("%s: %s", kind, strings.TrimPrefix(err.Error(), "kubectl failed: ")))
				}
				break
			}
			for _, line := range strings.Split(text, "\n") {
				fields := strings.Fields(line)
				if len(fields) < 2 {
					continue
				}
				objNS, name := fields[0], fields[1]
				if objNS == "<none>" {
					objNS = ""
				}
				labels := ""
				if len(fields) > 2 {
					labels = strings.Join(fields[2:], " ")
				}
				hit := false
				if byLabel {
					hit = labelMatch(labels, labelKey, labelValue)
				} else {
					hit = strings.Contains(strings.ToLower(name), needle) || strings.Contains(strings.ToLower(labels), needle)
				}
				if !hit {
					continue
				}
				if len(matches) >= limit {
					truncated = true
					break
				}
				entry := map[string]string{"kind": kind, "name": name}
				if objNS != "" {
					entry["namespace"] = objNS
				}
				matches = append(matches, entry)
			}
		}
	}
	result := map[string]interface{}{
		"query":     query,
		"matches":   matches,
		"searched":  map[string]interface{}{"kinds": kinds, "namespaces": searched},
		"truncated": truncated,
		"notes":     notes,
	}
	if len(matches) == 0 {
		result["hint"] = "Nothing matched in the searched kinds and namespaces. Stop searching: tell the user what was searched and ask for the exact name, the namespace, or whether it lives in another cluster."
	}
	return marshalJSON(result)
}

// labelMatch finds key:value in kubectl's map[k:v k2:v2] rendering of labels,
// on a key boundary so app:web does not match myapp:web.
func labelMatch(labels, key, value string) bool {
	pair := key + ":" + value
	for _, lead := range []string{"[", " "} {
		i := strings.Index(labels, lead+pair)
		for i >= 0 {
			end := i + len(lead) + len(pair)
			if end >= len(labels) || labels[end] == ' ' || labels[end] == ']' {
				return true
			}
			next := strings.Index(labels[i+1:], lead+pair)
			if next < 0 {
				break
			}
			i += 1 + next
		}
	}
	return false
}

// nsTargets turns the namespace scope into kubectl namespace arguments, one
// entry per call: the whole cluster is one call, a scoped grant one per namespace.
func nsTargets(namespaces []string) [][]string {
	if len(namespaces) == 0 {
		return [][]string{{"--all-namespaces"}}
	}
	out := make([][]string, 0, len(namespaces))
	for _, ns := range namespaces {
		out = append(out, []string{"-n", ns})
	}
	return out
}

func handleExplain(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resource := strings.TrimSpace(argString(args, "resource", ""))
	if resource == "" {
		return "", wrapBadRequest("resource parameter is required (for example deployments or deployments.spec.strategy)")
	}
	cmd := []string{"explain", resource}
	if v := argString(args, "api_version", ""); v != "" {
		cmd = append(cmd, "--api-version="+v)
	}
	if argBool(args, "recursive") {
		cmd = append(cmd, "--recursive")
	}
	out, err := runKubectl(ctx, headers, cmd...)
	if err != nil {
		if res, ok := failureResult(ctx, headers, err, resource, "", ""); ok {
			return res, nil
		}
		if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "couldn't find resource") {
			return marshalJSON(map[string]interface{}{
				"status":   "unknown_field",
				"resource": resource,
				"reason":   strings.TrimPrefix(err.Error(), "kubectl failed: "),
				"hint":     "Call k8s_explain on the parent path (for example deployments.spec) to list the fields that exist.",
			})
		}
		return "", err
	}
	if len(out) > explainMaxBytes {
		out = out[:explainMaxBytes] + fmt.Sprintf(truncatedMarker, explainMaxBytes)
	}
	return out, nil
}
