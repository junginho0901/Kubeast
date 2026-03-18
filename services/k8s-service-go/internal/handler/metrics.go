package handler

import (
	"net/http"

	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetPodMetrics handles GET /api/v1/metrics/pods.
func (h *Handler) GetPodMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := queryParam(r, "namespace", "")
	data, err := h.svc.GetPodMetrics(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNodeMetrics handles GET /api/v1/metrics/nodes.
func (h *Handler) GetNodeMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetNodeMetrics(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetTopResources handles GET /api/v1/metrics/top-resources.
func (h *Handler) GetTopResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	podLimit := queryParamInt(r, "pod_limit", 10)
	nodeLimit := queryParamInt(r, "node_limit", 10)
	data, err := h.svc.GetTopResources(ctx, podLimit, nodeLimit)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
