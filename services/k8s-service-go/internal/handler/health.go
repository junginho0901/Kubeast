package handler

import (
	"context"
	"net/http"
	"time"

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
// liveness probe에서도 사용되므로 항상 200을 반환한다.
// kubernetes 연결 상태는 별도로 짧은 타임아웃으로 확인한다.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	k8sStatus := "connected"
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	if err := h.svc.HealthCheck(ctx); err != nil {
		k8sStatus = "disconnected"
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"status":     "healthy",
		"kubernetes": k8sStatus,
	})
}
