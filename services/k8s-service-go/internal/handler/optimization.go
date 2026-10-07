package handler

import (
	"net/http"

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
