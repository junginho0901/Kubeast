package handler

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetClusterTimeline handles GET /api/v1/timeline — events and rollout history
// across every namespace.
func (h *Handler) GetClusterTimeline(w http.ResponseWriter, r *http.Request) {
	h.serveNamespaceTimeline(w, r, metav1.NamespaceAll)
}

// GetNamespaceTimeline handles GET /api/v1/cluster/namespaces/{namespace}/timeline
func (h *Handler) GetNamespaceTimeline(w http.ResponseWriter, r *http.Request) {
	h.serveNamespaceTimeline(w, r, chi.URLParam(r, "namespace"))
}

func (h *Handler) serveNamespaceTimeline(w http.ResponseWriter, r *http.Request, namespace string) {
	ctx := r.Context()
	hours := queryParamInt(r, "hours", 24)
	limit := queryParamInt(r, "limit", 500)

	cid, _ := cluster.FromContext(ctx)
	cacheKey := "timeline|ns|" + string(cid) + "|" + namespace + "|" + r.URL.RawQuery

	var cached interface{}
	if h.svc.Cache().Get(ctx, cacheKey, &cached) {
		response.JSON(w, http.StatusOK, cached)
		return
	}

	result, err := h.svc.GetNamespaceTimeline(ctx, namespace, hours, limit)
	if err != nil {
		h.handleError(w, err)
		return
	}

	h.svc.Cache().Set(ctx, cacheKey, result, 30*time.Second)
	response.JSON(w, http.StatusOK, result)
}

// GetResourceTimeline handles GET /api/v1/cluster/namespaces/{namespace}/timeline/{kind}/{name}
func (h *Handler) GetResourceTimeline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")
	hours := queryParamInt(r, "hours", 24)
	limit := queryParamInt(r, "limit", 500)

	cid, _ := cluster.FromContext(ctx)
	cacheKey := "timeline|res|" + string(cid) + "|" + namespace + "|" + kind + "|" + name + "|" + r.URL.RawQuery

	var cached interface{}
	if h.svc.Cache().Get(ctx, cacheKey, &cached) {
		response.JSON(w, http.StatusOK, cached)
		return
	}

	result, err := h.svc.GetResourceTimeline(ctx, namespace, kind, name, hours, limit)
	if err != nil {
		h.handleError(w, err)
		return
	}

	h.svc.Cache().Set(ctx, cacheKey, result, 30*time.Second)
	response.JSON(w, http.StatusOK, result)
}
