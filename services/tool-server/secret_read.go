// Secrets are readable for the assistant, but never their values (OWASP LLM02); the screen shows them behind
// resource.secret.reveal and an audit row. What tool-server decodes loses the values at the read (getJSONList,
// redact.StripSecrets), so a jq program or a group cannot compute from them. What kubectl computes itself — a table,
// a jsonpath, a go-template — cannot be stripped first, so for a Secret it is refused before kubectl runs. Everything
// else leaves through handleCall's masking.

package main

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/junginho0901/kubeast/services/pkg/redact"
)

type readMasksKey struct{}

// withReadMasks counts what a read takes out of a Secret before the answer is written, which the answer's masking cannot
// see any more and the audit row says all the same.
func withReadMasks(ctx context.Context) (context.Context, *atomic.Int64) {
	count := &atomic.Int64{}
	return context.WithValue(ctx, readMasksKey{}, count), count
}

func countReadMasks(ctx context.Context, n int) {
	if count, ok := ctx.Value(readMasksKey{}).(*atomic.Int64); ok {
		count.Add(int64(n))
	}
}

// addReadMasks puts what the read took out next to what the answer's masking did, as the kind of a Secret's values.
func addReadMasks(stats *redact.Stats, count *atomic.Int64) *redact.Stats {
	n := int(count.Load())
	if n == 0 {
		return stats
	}
	if stats == nil {
		stats = &redact.Stats{}
	}
	if stats.Kinds == nil {
		stats.Kinds = map[string]int{}
	}
	stats.Kinds["secret"] += n
	stats.Count += n
	return stats
}

// namesSecrets: a kubectl resource argument that lists core Secrets, by any spelling kubectl takes or nearly takes:
// any case, the singular, version or group forms, one of several separated by commas. <plural>.<group with a dot> is
// another API's resource (kubectl's group names for custom resources always have one).
func namesSecrets(resourceType string) bool {
	for _, one := range strings.Split(resourceType, ",") {
		name, rest, _ := strings.Cut(strings.ToLower(strings.TrimSpace(one)), ".")
		if (name == "secret" || name == "secrets") && (!strings.Contains(rest, ".") || rest == "v1.core") {
			return true
		}
	}
	return false
}

// namesAllCategory: kubectl's category "all", which lists several kinds under one name.
func namesAllCategory(resourceType string) bool {
	for _, one := range strings.Split(resourceType, ",") {
		if strings.EqualFold(strings.TrimSpace(one), "all") {
			return true
		}
	}
	return false
}

// secretRefusal answers a call that would print a Secret's values, so the model does not try the next spelling.
func secretRefusal(resourceType string) (string, error) {
	return marshalJSON(map[string]interface{}{
		"status":        "forbidden",
		"resource_type": resourceType,
		"reason":        "A Secret's values never go to the model, and this output is computed by kubectl from the object, so the values could not be removed first.",
		"hint": "Which keys a Secret has: k8s_describe_resource (keys and sizes) or k8s_jq_query with .items[] | {name: .metadata.name, type: .type, keys: (.data | keys)}. " +
			"How many: k8s_count. The values themselves: tell the user to open the Secret on the screen, which needs resource.secret.reveal and is audited.",
	})
}

// refuseSecretExpression stops an output kubectl computes (a table, jsonpath, go-template) on a list that holds Secrets.
// cmd is the kubectl get to run, without its -o. A category is asked what it lists first, by name only.
func refuseSecretExpression(ctx context.Context, headers http.Header, resourceType, name, namespace string, cmd []string) (string, bool, error) {
	if namesSecrets(resourceType) {
		out, err := secretRefusal(resourceType)
		return out, true, err
	}
	if !namesAllCategory(resourceType) {
		return "", false, nil
	}
	names, err := runKubectl(ctx, headers, append(append([]string{}, cmd...), "-o", "name")...)
	if err != nil {
		out, err := explainFailure(ctx, headers, err, resourceType, name, namespace)
		return out, true, err
	}
	for _, line := range strings.Split(names, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "secret/") {
			out, err := secretRefusal(resourceType)
			return out, true, err
		}
	}
	return "", false, nil
}

// outputExpression: an -o value kubectl computes from the object, as opposed to a fixed form tool-server can mask.
func outputExpression(output string) bool {
	for _, p := range outputPrefixes {
		if strings.HasPrefix(output, p) {
			return true
		}
	}
	return false
}

// secretValuePath: a group_by path into a Secret's values.
func secretValuePath(path string) bool {
	path = strings.TrimLeft(path, ".")
	for _, field := range []string{"data", "stringData"} {
		if path == field || strings.HasPrefix(path, field+".") || strings.HasPrefix(path, field+"[") {
			return true
		}
	}
	return false
}
