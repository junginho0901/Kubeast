package handler

import (
	"net/http"

	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// HealthRoot handles GET /.
func (h *Handler) HealthRoot(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"service": h.cfg.AppName,
	})
}

// HealthCheck handles GET /health.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := h.svc.HealthCheck(ctx); err != nil {
		response.Error(w, http.StatusServiceUnavailable, "kubernetes API unreachable: "+err.Error())
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"status":     "healthy",
		"kubernetes": "connected",
	})
}
