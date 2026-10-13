package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetCost handles GET /api/v1/cost?window=&aggregate=: OpenCost's allocation
// for the cluster by namespace or by workload, within the caller's namespace
// scope (features.cost, permission resource.cost.read). A plain read: no audit.
func (h *Handler) GetCost(w http.ResponseWriter, r *http.Request) {
	if !k8s.CostFeatureEnabled() {
		response.Error(w, http.StatusNotFound, "cost is off (features.cost.enabled)")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.cost.read"); err != nil {
		h.handleError(w, err)
		return
	}
	window := queryParam(r, "window", "24h")
	aggregate := queryParam(r, "aggregate", k8s.CostAggregateNamespace)
	if !k8s.CostWindowAllowed(window) || !k8s.CostAggregateAllowed(aggregate) {
		response.Error(w, http.StatusBadRequest, "window must be one of "+strings.Join(k8s.CostWindows(), ", ")+" and aggregate namespace or controller")
		return
	}
	res, err := h.svc.CostAllocation(r.Context(), window, aggregate)
	if errors.Is(err, k8s.ErrCostNotFound) {
		response.Error(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// GetCostStatus handles GET /api/v1/cost/status: whether the cluster has an
// OpenCost the proxy can reach, and where.
func (h *Handler) GetCostStatus(w http.ResponseWriter, r *http.Request) {
	if !k8s.CostFeatureEnabled() {
		response.Error(w, http.StatusNotFound, "cost is off (features.cost.enabled)")
		return
	}
	if err := h.requirePermissionForCluster(r, "resource.cost.read"); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, h.svc.CostStatus(r.Context()))
}
