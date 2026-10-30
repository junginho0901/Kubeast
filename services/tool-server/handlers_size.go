package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// listMax: the most objects of a kind other than pods that a tool lists whole with kubectl. kubectl holds the whole
// list whatever the output (110 000 events took it 0.98–1.8 GB as JSON, a table, names or columns) and tool-server
// has 256 Mi, so a larger list is answered with its size instead of being read — as podsKubectlMax for pods.
const listMax = 5000

// listSizePage: the page a selector's matches are counted in (the API server leaves the count out with a selector).
const listSizePage = 500

// apiResourcesTTL: how long a cluster's kubectl api-resources answer is kept for finding list paths.
const apiResourcesTTL = 5 * time.Minute

type listSizeResult struct {
	count   int
	atLeast bool // count is a lower bound: a selector's matches were counted up to listMax+1, or a page was too big
}

type apiResourcesEntry struct {
	at        time.Time
	resources []map[string]interface{}
}

var (
	apiResourcesMu    sync.Mutex
	apiResourcesCache = map[string]apiResourcesEntry{}
)

// listSize asks the API server how many objects a list of kind would hold, without kubectl reading them: a GET of the
// list path with limit=1 answers the items and metadata.remainingItemCount. With a label or field selector the API
// server leaves that count out, so the matches are counted listSizePage at a time up to listMax+1. ok is false when
// kind is not in kubectl api-resources; the caller then lists as before.
func listSize(ctx context.Context, headers http.Header, kind, namespace string, allNamespaces bool, labelSelector, fieldSelector string) (listSizeResult, bool, error) {
	path, ok, err := listPath(ctx, headers, kind, namespace, allNamespaces)
	if err != nil || !ok {
		return listSizeResult{}, false, err
	}
	q := url.Values{}
	if labelSelector != "" {
		q.Set("labelSelector", labelSelector)
	}
	if fieldSelector != "" {
		q.Set("fieldSelector", fieldSelector)
	}
	limit := 1
	if len(q) > 0 {
		limit = listSizePage
	}
	n := 0
	for {
		q.Set("limit", strconv.Itoa(limit))
		out, err := runKubectl(ctx, headers, "get", "--raw", path+"?"+q.Encode())
		if err != nil {
			return listSizeResult{}, false, err
		}
		if outputCut(out) {
			// a page of listSizePage objects larger than the tool output: far beyond what kubectl may list
			return listSizeResult{count: listMax + 1, atLeast: true}, true, nil
		}
		var page struct {
			Items    []json.RawMessage `json:"items"`
			Metadata struct {
				Continue           string `json:"continue"`
				RemainingItemCount *int64 `json:"remainingItemCount"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal([]byte(out), &page); err != nil {
			return listSizeResult{}, false, fmt.Errorf("list size: unreadable answer: %w", err)
		}
		n += len(page.Items)
		switch {
		case page.Metadata.Continue == "":
			return listSizeResult{count: n}, true, nil
		case page.Metadata.RemainingItemCount != nil && limit == 1:
			return listSizeResult{count: n + int(*page.Metadata.RemainingItemCount)}, true, nil
		case n > listMax:
			return listSizeResult{count: n, atLeast: true}, true, nil
		}
		limit = listSizePage
		q.Set("continue", page.Metadata.Continue)
	}
}

// listPath is the API path of kind's list in namespace (all namespaces, or none for a cluster-scoped kind), found in
// kubectl api-resources as kubectl finds it: the plural name, a short name, the Kind, or <plural>.<group>.
func listPath(ctx context.Context, headers http.Header, kind, namespace string, allNamespaces bool) (string, bool, error) {
	resources, err := apiResources(ctx, headers)
	if err != nil {
		return "", false, err
	}
	want, group := strings.ToLower(strings.TrimSpace(kind)), ""
	if i := strings.Index(want, "."); i > 0 {
		want, group = want[:i], want[i+1:]
	}
	for _, r := range resources {
		name, _ := r["name"].(string)
		apiVersion, _ := r["apiVersion"].(string)
		if group != "" && !strings.HasPrefix(apiVersion, group+"/") {
			continue
		}
		if !resourceNamed(r, want) {
			continue
		}
		base := "/api/" + apiVersion
		if strings.Contains(apiVersion, "/") {
			base = "/apis/" + apiVersion
		}
		if namespaced, _ := r["namespaced"].(bool); !namespaced || allNamespaces {
			return base + "/" + name, true, nil
		}
		if namespace == "" {
			namespace = "default"
		}
		return base + "/namespaces/" + url.PathEscape(namespace) + "/" + name, true, nil
	}
	return "", false, nil
}

func resourceNamed(r map[string]interface{}, want string) bool {
	name, _ := r["name"].(string)
	kind, _ := r["kind"].(string)
	if name == want || strings.ToLower(kind) == want || name == want+"s" || name == want+"es" ||
		(strings.HasSuffix(want, "y") && name == strings.TrimSuffix(want, "y")+"ies") {
		return true
	}
	short, _ := r["shortNames"].([]string)
	for _, s := range short {
		if s == want {
			return true
		}
	}
	return false
}

func apiResources(ctx context.Context, headers http.Header) ([]map[string]interface{}, error) {
	key := clusterIDFromCtx(ctx)
	apiResourcesMu.Lock()
	e, ok := apiResourcesCache[key]
	apiResourcesMu.Unlock()
	if ok && time.Since(e.at) < apiResourcesTTL {
		return e.resources, nil
	}
	out, err := runKubectl(ctx, headers, "api-resources")
	if err != nil {
		return nil, err
	}
	resources := parseAPIResources(out)
	apiResourcesMu.Lock()
	apiResourcesCache[key] = apiResourcesEntry{at: time.Now(), resources: resources}
	apiResourcesMu.Unlock()
	return resources, nil
}

// listTooLarge answers a list kubectl would have to hold whole when it holds more than listMax objects.
func listTooLarge(kind, scope string, size listSizeResult) (string, error) {
	reply := map[string]interface{}{
		"status": "too_large", "resource_type": kind, "scope": scope,
		"reason": fmt.Sprintf("%d objects match; this tool lists them whole with kubectl, which holds at most %d", size.count, listMax),
		"hint":   "Narrow with namespace, label_selector or field_selector. k8s_count answers how many at any size; for events, k8s_get_events lists the newest.",
	}
	if size.atLeast {
		reply["count_at_least"] = size.count
		reply["reason"] = fmt.Sprintf("more than %d objects match; this tool lists them whole with kubectl, which holds at most %d", listMax, listMax)
	} else {
		reply["count"] = size.count
	}
	return marshalJSON(reply)
}

// listTooMany stops a list tool (jq, table, count by a field) on a kind other than pods with listTooLarge when the
// list holds more than listMax objects. A size that cannot be asked lets kubectl run, which answers its own failure.
func listTooMany(ctx context.Context, headers http.Header, args map[string]interface{}, scope string) (string, bool, error) {
	kind := argString(args, "resource_type", "")
	if isPodsKind(kind) {
		return "", false, nil
	}
	namespace := argString(args, "namespace", "")
	size, ok, err := listSize(ctx, headers, kind, namespace, namespace == "", argString(args, "label_selector", ""), argString(args, "field_selector", ""))
	if err != nil || !ok || size.count <= listMax {
		return "", false, nil
	}
	out, err := listTooLarge(kind, scope, size)
	return out, true, err
}
