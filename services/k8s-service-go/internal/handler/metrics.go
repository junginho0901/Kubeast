package handler

import (
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// handleMetricsError: the API server's 503 or 504 for metrics.k8s.io is metrics-server not answering, not the cluster, so a 502, which the breaker does not count.
func (h *Handler) handleMetricsError(w http.ResponseWriter, err error) {
	if apierrors.IsServiceUnavailable(err) || apierrors.IsTimeout(err) || apierrors.IsServerTimeout(err) {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	h.handleError(w, err)
}

// GetPodMetrics handles GET /api/v1/metrics/pods.
func (h *Handler) GetPodMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := queryParam(r, "namespace", "")
	data, err := h.svc.GetPodMetrics(ctx, namespace)
	if err != nil {
		h.handleMetricsError(w, err)
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
		h.handleMetricsError(w, err)
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
