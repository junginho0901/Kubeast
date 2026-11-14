package handler

import (
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetResourceGraph handles GET /api/v1/resource-graph?namespaces=ns1,ns2
// If no namespaces query param, returns graph for all namespaces. group_pods=1 folds the healthy pods of an
// owner with many pods into groups, inside the page's grouping (group_by: node, instance); expand lists groups
// drawn pod by pod.
func (h *Handler) GetResourceGraph(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	opts, ok := resourceGraphOptions(w, q)
	if !ok {
		return
	}
	data, err := h.svc.GetResourceGraph(ctx, splitList(q.Get("namespaces")), opts)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// resourceGraphOptions reads group_pods, group_by and expand; false after it answered 400.
func resourceGraphOptions(w http.ResponseWriter, q url.Values) (k8s.ResourceGraphOptions, bool) {
	opts := k8s.ResourceGraphOptions{GroupPods: q.Get("group_pods") == "1" || q.Get("group_pods") == "true"}
	switch g := q.Get("group_by"); g {
	case "", "none", "namespace":
	case "node", "instance":
		opts.GroupBy = g
	default:
		response.Error(w, http.StatusBadRequest, "group_by must be none, namespace, node or instance")
		return opts, false
	}
	opts.Expand = splitList(q.Get("expand"))
	return opts, true
}

// GetNamespaceResourceGraph handles GET /api/v1/namespaces/{namespace}/resource-graph
// Backwards-compatible single-namespace endpoint (the AI tool resource_graph), with the same options.
// include=calls (with range, 1m–24h, default 1h) adds calls: who calls whom (resourceGraphCalls, features.callGraph).
func (h *Handler) GetNamespaceResourceGraph(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	q := r.URL.Query()
	opts, ok := resourceGraphOptions(w, q)
	if !ok {
		return
	}
	calls := false
	for _, inc := range splitList(q.Get("include")) {
		if inc != "calls" {
			response.Error(w, http.StatusBadRequest, "include takes calls only")
			return
		}
		calls = true
	}
	if _, err := netdrops.ParseRange(q.Get("range")); calls && err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	data, err := h.svc.GetResourceGraph(ctx, []string{namespace}, opts)
	if err != nil {
		h.handleError(w, err)
		return
	}
	if calls {
		res, err := h.resourceGraphCalls(r, namespace, data, q.Get("range"))
		if err != nil {
			h.handleError(w, err)
			return
		}
		// the graph may be the cached map: the answer is a copy with calls added
		out := make(map[string]interface{}, len(data)+1)
		for k, v := range data {
			out[k] = v
		}
		out["calls"] = res
		data = out
	}
	response.JSON(w, http.StatusOK, data)
}
