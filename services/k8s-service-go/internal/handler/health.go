package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
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
// audit 블록은 감사 writer 상태(fail-closed 여부·DB 도달·쓰기 실패 수) —
// 파드를 빼지는 않고(readiness 무관) 보이게만 한다.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	k8sStatus := "connected"
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	if err := h.svc.HealthCheck(ctx); err != nil {
		k8sStatus = "disconnected"
	}
	body := map[string]interface{}{
		"status":     "healthy",
		"kubernetes": k8sStatus,
	}
	if st, ok := h.auditStore.(audit.Statuser); ok {
		body["audit"] = st.Status(ctx)
	}
	response.JSON(w, http.StatusOK, body)
}
