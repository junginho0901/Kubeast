// kubectl failures the model can act on come back as a JSON result
// ({"status": "not_found", ...}) instead of an error string. The cheap
// follow-up — does the namespace exist, which names are close — is done here
// in one extra kubectl call, so the model does not spend two or three rounds
// guessing namespaces and spellings. A caller whose grant is limited to
// namespaces only sees names from those namespaces.

package main

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var (
	// kubectl get/describe print "Error from server (NotFound): pods "x" not found";
	// kubectl logs prints "error: error from server (NotFound): pods "x" not found in namespace "ns"".
	reNotFound        = regexp.MustCompile(`(?i)error from server \(NotFound\): ([a-z0-9.-]+) "([^"]+)" not found`)
	reUnknownKind     = regexp.MustCompile(`the server doesn't have a resource type "([^"]+)"`)
	reNoPrevious      = regexp.MustCompile(`previous terminated container "([^"]+)" in pod "([^"]+)" not found`)
	reChooseContainer = regexp.MustCompile(`a container name must be specified for pod ([^,]+), choose one of: \[([^\]]*)\]`)
	reMetricsMissing  = regexp.MustCompile(`Metrics API not available|metrics\.k8s\.io`)
	// A ReplicaSet pod template hash or a pod's random suffix: 5–10 characters
	// from Kubernetes' safe-encoding alphabet (no vowels, so "cache" or "redis"
	// are not stripped).
	reHashSuffix = regexp.MustCompile(`-[bcdfghjklmnpqrstvwxz2456789]{5,10}$`)
)

// candidateListCap bounds the names scanned for suggestions.
const candidateListCap = 5000

// kubectlFailure is a kubectl error the model can act on.
type kubectlFailure struct {
	Status     string
	Kind       string
	Name       string
	Containers []string
}

// classifyKubectlFailure reads the kubectl error text.
func classifyKubectlFailure(err error) (kubectlFailure, bool) {
	if err == nil {
		return kubectlFailure{}, false
	}
	text := err.Error()
	if m := reNoPrevious.FindStringSubmatch(text); m != nil {
		return kubectlFailure{Status: "no_previous", Kind: "pods", Name: m[2], Containers: []string{m[1]}}, true
	}
	if m := reChooseContainer.FindStringSubmatch(text); m != nil {
		return kubectlFailure{Status: "container_required", Kind: "pods", Name: strings.TrimSpace(m[1]), Containers: strings.Fields(m[2])}, true
	}
	if m := reNotFound.FindStringSubmatch(text); m != nil {
		return kubectlFailure{Status: "not_found", Kind: m[1], Name: m[2]}, true
	}
	if m := reUnknownKind.FindStringSubmatch(text); m != nil {
		return kubectlFailure{Status: "unknown_kind", Kind: m[1]}, true
	}
	if reMetricsMissing.MatchString(text) {
		return kubectlFailure{Status: "unavailable", Kind: "metrics-server"}, true
	}
	return kubectlFailure{}, false
}

// failureResult turns a classified kubectl failure into the tool's JSON
// result. ok is false when the error is not one the model can act on.
func failureResult(ctx context.Context, headers http.Header, err error, kind, name, namespace string) (string, bool) {
	f, ok := classifyKubectlFailure(err)
	if !ok {
		return "", false
	}
	var result map[string]interface{}
	switch f.Status {
	case "not_found":
		if kind == "" {
			kind = f.Kind
		}
		if name == "" {
			name = f.Name
		}
		result = map[string]interface{}{
			"status":    "not_found",
			"kind":      f.Kind,
			"name":      name,
			"namespace": namespace,
		}
		if namespace != "" {
			result["namespace_exists"] = namespaceExists(ctx, headers, namespace)
		}
		candidates, scope, truncated := listNames(ctx, headers, kind, scopedNamespaces(ctx))
		result["similar"] = similarNames(name, candidates)
		result["searched"] = scope
		if truncated {
			result["searched_truncated"] = true
		}
		result["hint"] = notFoundHint(kind, result["similar"].([]map[string]string))
	case "unknown_kind":
		result = map[string]interface{}{
			"status":        "unknown_kind",
			"kind":          f.Kind,
			"similar_kinds": similarKinds(ctx, headers, f.Kind),
			"hint":          "The cluster has no such resource type. Use one of similar_kinds, or call k8s_get_available_api_resources for the full list.",
		}
	case "no_previous":
		result = map[string]interface{}{
			"status":    "no_previous",
			"pod":       name,
			"namespace": namespace,
			"container": f.Containers[0],
			"hint":      "The container has not restarted, so there is no previous log. Read the current log (previous=false) and the pod's events instead.",
		}
	case "container_required":
		result = map[string]interface{}{
			"status":     "container_required",
			"pod":        name,
			"namespace":  namespace,
			"containers": f.Containers,
			"hint":       "The pod has several containers. Call again with container=<one of containers>, or all_containers=true.",
		}
	case "unavailable":
		result = map[string]interface{}{
			"status":      "unavailable",
			"feature":     f.Kind,
			"reason":      strings.TrimPrefix(err.Error(), "kubectl failed: "),
			"alternative": "This cluster has no metrics-server, so CPU/memory usage is not available. Use k8s_describe_resource (requests, limits, restarts) and k8s_get_events instead, and say that usage figures are unavailable here.",
		}
	default:
		return "", false
	}
	out, mErr := marshalJSON(result)
	if mErr != nil {
		return "", false
	}
	return out, true
}

func namespaceExists(ctx context.Context, headers http.Header, namespace string) bool {
	_, err := runKubectl(ctx, headers, "get", "namespace", namespace, "-o", "name")
	return err == nil
}

// scopedNamespaces returns the namespaces the caller's grant on this cluster
// is limited to; nil means the whole cluster.
func scopedNamespaces(ctx context.Context) []string {
	p, ok := auth.FromContext(ctx)
	if !ok {
		return nil
	}
	return p.Namespaces[clusterIDFromCtx(ctx)]
}

type namedObject struct {
	Namespace string
	Name      string
}

// listNames lists kind across the scope (all namespaces, or the granted ones)
// as namespace/name pairs. scope is what the result reports as searched.
func listNames(ctx context.Context, headers http.Header, kind string, namespaces []string) ([]namedObject, interface{}, bool) {
	var out []namedObject
	truncated := false
	collect := func(args ...string) {
		if truncated {
			return
		}
		cmd := append([]string{"get", kind}, args...)
		cmd = append(cmd, "-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name", "--no-headers")
		text, err := runKubectl(ctx, headers, cmd...)
		if err != nil {
			return
		}
		for _, line := range strings.Split(text, "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			if len(out) >= candidateListCap {
				truncated = true
				return
			}
			ns := fields[0]
			if ns == "<none>" {
				ns = ""
			}
			out = append(out, namedObject{Namespace: ns, Name: fields[1]})
		}
	}
	if len(namespaces) == 0 {
		collect("--all-namespaces")
		return out, "all namespaces", truncated
	}
	for _, ns := range namespaces {
		collect("-n", ns)
	}
	return out, namespaces, truncated
}

// stripHash removes a pod's ReplicaSet hash and random suffix (web-7d9f8c6b5-abcde → web).
func stripHash(name string) string {
	for i := 0; i < 2; i++ {
		next := reHashSuffix.ReplaceAllString(name, "")
		if next == "" || next == name {
			break
		}
		name = next
	}
	return name
}

// similarNames ranks candidates against the name the model asked for: same
// stem, prefix, substring, shared token, then edit distance ≤ 2. At most ten.
func similarNames(target string, candidates []namedObject) []map[string]string {
	t := strings.ToLower(stripHash(target))
	type scored struct {
		obj   namedObject
		score int
	}
	var picked []scored
	for _, c := range candidates {
		name := strings.ToLower(c.Name)
		stem := strings.ToLower(stripHash(c.Name))
		score := -1
		switch {
		case name == strings.ToLower(target) || stem == t:
			score = 0
		case strings.HasPrefix(stem, t) || strings.HasPrefix(t, stem):
			score = 1
		case strings.Contains(stem, t) || strings.Contains(t, stem):
			score = 2
		case sharesToken(stem, t):
			score = 3
		case editDistanceAtMost(stem, t, 2):
			score = 4
		}
		if score >= 0 {
			picked = append(picked, scored{c, score})
		}
	}
	sort.Slice(picked, func(i, j int) bool {
		if picked[i].score != picked[j].score {
			return picked[i].score < picked[j].score
		}
		if picked[i].obj.Namespace != picked[j].obj.Namespace {
			return picked[i].obj.Namespace < picked[j].obj.Namespace
		}
		return picked[i].obj.Name < picked[j].obj.Name
	})
	out := make([]map[string]string, 0, 10)
	for _, p := range picked {
		if len(out) == 10 {
			break
		}
		entry := map[string]string{"name": p.obj.Name}
		if p.obj.Namespace != "" {
			entry["namespace"] = p.obj.Namespace
		}
		out = append(out, entry)
	}
	return out
}

func tokens(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return r == '-' || r == '.' || r == '_' })
}

// sharesToken: the two names have a token of three or more characters in common.
func sharesToken(a, b string) bool {
	seen := map[string]bool{}
	for _, t := range tokens(a) {
		if len(t) >= 3 {
			seen[t] = true
		}
	}
	for _, t := range tokens(b) {
		if len(t) >= 3 && seen[t] {
			return true
		}
	}
	return false
}

// editDistanceAtMost reports whether the Levenshtein distance is ≤ limit.
func editDistanceAtMost(a, b string, limit int) bool {
	if a == "" || b == "" {
		return false
	}
	if d := len(a) - len(b); d > limit || d < -limit {
		return false
	}
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		rowMin := cur[0]
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			rowMin = min(rowMin, cur[j])
		}
		if rowMin > limit {
			return false
		}
		prev, cur = cur, prev
	}
	return prev[len(b)] <= limit
}

func notFoundHint(kind string, similar []map[string]string) string {
	base := "No object with that exact name"
	if len(similar) > 0 {
		base += "; similar lists the closest names in the searched namespaces"
	}
	if strings.HasPrefix(kind, "pod") {
		return base + ". Pod names carry a ReplicaSet hash suffix, so use the owner (Deployment/StatefulSet) name, a label selector, or k8s_find_resource with a name fragment."
	}
	return base + ". Check the namespace and spelling, or call k8s_find_resource with a name fragment or label (it searches several kinds across namespaces)."
}

// similarKinds suggests resource types close to an unknown one from kubectl api-resources.
func similarKinds(ctx context.Context, headers http.Header, kind string) []string {
	text, err := runKubectl(ctx, headers, "api-resources", "--no-headers", "-o", "name")
	if err != nil {
		return []string{}
	}
	var names []namedObject
	for _, line := range strings.Split(text, "\n") {
		if n := strings.TrimSpace(line); n != "" {
			names = append(names, namedObject{Name: n})
		}
	}
	// api-resources prints plural.group; match on the plural alone too.
	want := strings.ToLower(strings.TrimSuffix(kind, "s"))
	out := []string{}
	for _, m := range similarNames(kind, names) {
		out = append(out, m["name"])
	}
	if len(out) == 0 {
		for _, n := range names {
			plural := strings.SplitN(n.Name, ".", 2)[0]
			if editDistanceAtMost(strings.TrimSuffix(plural, "s"), want, 2) {
				out = append(out, n.Name)
			}
		}
	}
	if len(out) > 10 {
		out = out[:10]
	}
	return out
}

// explainFailure is failureResult for handlers that know the object they asked for.
func explainFailure(ctx context.Context, headers http.Header, err error, kind, name, namespace string) (string, error) {
	if res, ok := failureResult(ctx, headers, err, kind, name, namespace); ok {
		return res, nil
	}
	return "", err
}
