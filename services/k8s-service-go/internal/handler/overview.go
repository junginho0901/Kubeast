package handler

import (
	"net/http"

	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetOverview handles GET /api/v1/overview.
func (h *Handler) GetOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetClusterOverview(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAPIResources handles GET /api/v1/api-resources.
func (h *Handler) GetAPIResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAPIResources(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetClusterConfig handles GET /api/v1/cluster-config.
func (h *Handler) GetClusterConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetClusterConfig(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetComponentStatuses handles GET /api/v1/componentstatuses.
// Note: ComponentStatus API is deprecated since K8s 1.19 and returns empty in newer versions.
func (h *Handler) GetComponentStatuses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetComponentStatuses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
