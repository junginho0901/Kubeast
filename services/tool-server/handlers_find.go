// k8s_find_resource looks for objects by a name fragment or a label across
// several kinds and namespaces, so the model does not guess namespaces one
// kubectl get at a time; with AI_TOOL_RESULT_DETAILS it looks among the names
// of the namespaces too. k8s_explain hands the model the API schema
// (kubectl explain) so it stops inventing field names.

package main

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

var findDefaultKinds = []string{"pods", "deployments", "statefulsets", "daemonsets", "services", "ingresses", "configmaps", "jobs", "cronjobs"}

const (
	findMaxKinds   = 12
	findMaxMatches = 50
	// explainMaxBytes caps kubectl explain --recursive, which can run to hundreds of KB.
	explainMaxBytes = 64 << 10

	findStopHint = "Nothing matched in the searched kinds and namespaces. Stop searching: tell the user what was searched and ask for the exact name, the namespace, or whether it lives in another cluster."
	// With AI_TOOL_RESULT_DETAILS on: nothing found ends this search, not the work it was part of.
	findNothingHint = "Nothing matched in the searched kinds and namespaces (notes: what could not be read). Do not repeat this search with the same words: " +
		"its answer would be the same. Kinds not in searched were not looked at (name them in kinds), and an object deleted earlier is not listed. " +
		"This ends the search for the name, not the investigation: go on with what is known — the namespaces, the workloads, events, logs and metrics around the symptom. " +
		"If the user asked for this object itself, say what was searched and ask for the exact name, the namespace, or whether it lives in another cluster."
	findOneNamespaceHint  = " Only namespace %s was searched: leave namespace out to search every namespace the user may read. A namespace that does not exist answers the same."
	findNamespaceOnlyHint = "No object of the searched kinds matched; a namespace does. List what is in it (k8s_get_resources with that namespace)."
)

func handleFindResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	query := strings.TrimSpace(argString(args, "query", ""))
	if query == "" {
		return "", wrapBadRequest("query parameter is required")
	}
	kinds := argStringSlice(args, "kinds")
	kindsGiven := len(kinds) > 0
	if !kindsGiven {
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
	grant := namespaces
	inGrant := func(ns string) bool { return len(grant) == 0 || slices.Contains(grant, ns) }
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
		if isPodsKind(kind) {
			if found, total, note, ok := podsFind(ctx, headers, query, namespace, limit-len(matches)); ok {
				if note != "" {
					notes = append(notes, note)
				}
				for _, match := range found {
					if inGrant(match["namespace"]) {
						matches = append(matches, match)
					}
				}
				if total > len(found) {
					truncated = true
					notes = append(notes, fmt.Sprintf("pods: %d matched, %d listed", total, len(found)))
				}
				continue
			}
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
				// Past the -n above, what a grant may not see: a namespace is listed by its own name, as on the screens.
				if (objNS != "" && !inGrant(objNS)) || (isNamespaceKind(kind) && !inGrant(name)) {
					continue
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
	none := len(matches) == 0
	hint := findStopHint
	if resultDetails() {
		hint = findNothingHint
		switch {
		case namespace != "":
			hint += fmt.Sprintf(findOneNamespaceHint, namespace)
		// A namespace is found by its name: beside the default kinds, and for kinds given when they matched nothing.
		case !byLabel && !truncated && (!kindsGiven || none) && !slices.ContainsFunc(kinds, isNamespaceKind):
			kinds = append(slices.Clone(kinds), "namespaces")
			names, note := namespacesNamed(ctx, headers, needle, grant, limit-len(matches)+1)
			if note != "" {
				notes = append(notes, note)
			}
			for _, name := range names {
				if len(matches) >= limit {
					truncated = true
					break
				}
				matches = append(matches, map[string]string{"kind": "namespaces", "name": name})
			}
			if len(matches) > 0 {
				hint = findNamespaceOnlyHint
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
	if none {
		result["hint"] = hint
	}
	return marshalJSON(result)
}

// namespacesNamed lists at most the given number of namespaces whose name holds needle: of those the caller may list or,
// for a grant limited to namespaces, of its own. Those are read by name (such a grant may not list the cluster's) and one
// by one: a kubectl run of several names is an error when one of them is refused, and its other names are lost with it.
func namespacesNamed(ctx context.Context, headers http.Header, needle string, grant []string, most int) (names []string, note string) {
	holds := func(name string) bool { return strings.Contains(strings.ToLower(name), needle) }
	read := func(args ...string) error {
		cmd := append([]string{"get", "namespaces"}, args...)
		text, err := runKubectl(ctx, headers, append(cmd, "-o", "custom-columns=NAME:.metadata.name", "--no-headers")...)
		if err != nil {
			return err
		}
		for _, line := range strings.Split(text, "\n") {
			// one word: not the line that says the output was cut
			if f := strings.Fields(line); len(f) == 1 && holds(f[0]) && len(names) < most {
				names = append(names, f[0])
			}
		}
		return nil
	}
	why := func(err error) string { return strings.TrimPrefix(err.Error(), "kubectl failed: ") }
	if len(grant) == 0 {
		if err := read(); err != nil {
			return nil, "namespaces: " + why(err)
		}
		return names, ""
	}
	var unread []string
	var first error
	for _, ns := range grant {
		if !holds(ns) {
			continue
		}
		if len(names) >= most || ctx.Err() != nil {
			break
		}
		if err := read(ns, "--ignore-not-found"); err != nil {
			unread = append(unread, ns)
			if first == nil {
				first = err
			}
		}
	}
	if first != nil {
		note = "namespaces: " + strings.Join(unread, ", ") + ": " + why(first)
	}
	return names, note
}

func isNamespaceKind(kind string) bool {
	name, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(kind)), ".")
	return name == "namespaces" || name == "namespace" || name == "ns"
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
