package handler

import (
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/response"
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
	// with_limits=1 (Monitoring Pods): each row with its pod's cpu and memory limits, from the pod rows the
	// caller may see, so the page needs no pod list
	if queryParam(r, "with_limits", "") == "1" {
		h.svc.AddPodLimits(ctx, namespace, data)
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
