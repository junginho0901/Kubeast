package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetClusterOptimization handles GET /api/v1/optimization?namespace=…&window=…
// (gateway: /api/v1/cluster/optimization). window = hours of usage to size
// requests from (default OPTIMIZATION_WINDOW_HOURS).
func (h *Handler) GetClusterOptimization(w http.ResponseWriter, r *http.Request) {
	namespace := queryParam(r, "namespace", "")
	if namespace == "" {
		response.Error(w, http.StatusBadRequest, "namespace is required")
		return
	}
	window := queryParamInt(r, "window", h.cfg.OptimizationWindowHours)
	if window < 1 || window > 30*24 {
		window = h.cfg.OptimizationWindowHours
	}
	res, err := h.svc.CollectOptimization(r.Context(), namespace, window)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// ResizeOptimization handles POST /api/v1/namespaces/{namespace}/optimization/resize:
// one optimization row's values applied to the workload's running pods through
// the resize subresource, no restart (features.inPlaceResize, server 1.35+).
// Audited as k8s.pod.resize with the per-pod outcome.
func (h *Handler) ResizeOptimization(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.InPlaceResizeEnabled {
		response.Error(w, http.StatusNotFound, "in-place resize is off (features.inPlaceResize.enabled)")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.pod.edit"); err != nil {
		h.handleError(w, err)
		return
	}
	namespace := chi.URLParam(r, "namespace")
	var req k8s.ResizeRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	switch {
	case !k8s.ResizeKindAllowed(req.Kind) || req.Name == "" || req.Container == "":
		response.Error(w, http.StatusBadRequest, "kind (a workload kind), name and container are required")
		return
	case (req.CPURequestM == nil || *req.CPURequestM <= 0) && (req.MemRequestBytes == nil || *req.MemRequestBytes <= 0):
		response.Error(w, http.StatusBadRequest, "cpu_request_m or mem_request_bytes is required")
		return
	}
	if !h.svc.ServerSupportsResize(r.Context()) {
		response.Error(w, http.StatusConflict, "the API server is older than 1.35: pod resize is not available")
		return
	}
	res, err := h.svc.ResizeWorkload(r.Context(), namespace, req)
	var after json.RawMessage
	if res != nil {
		after, _ = json.Marshal(res)
	} else {
		after, _ = json.Marshal(req)
	}
	h.recordAuditWithPayload(r, "k8s.pod.resize", strings.ToLower(req.Kind), req.Name, namespace, err, nil, after)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}
