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

// Ready handles GET /readyz and GET /ready (the name the drain gave it first): 503 once the server has started leaving
// — SIGTERM (probe.Leave) or the drain — so whatever reads readiness, the kubelet's probe, a load balancer's target
// health, a readiness gate, stops sending it new connections; /livez and /health stay 200 meanwhile.
func (h *Handler) Ready(w http.ResponseWriter, r *http.Request) {
	if h.leaving.Leaving() || h.drain.Leaving() {
		response.JSON(w, http.StatusServiceUnavailable, map[string]interface{}{"status": "shutting down"})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"status": "ready"})
}

// HealthCheck handles GET /health, which the gateway's /health and the compose health check read.
// 항상 200을 반환한다 — kubelet 의 probe 는 /livez(liveness)·/readyz(readiness)다.
// kubernetes 연결 상태는 클러스터 상태 확인기가 돌면 그 차단기로, 아니면 2초 안의 /version 한 번으로 답한다(k8s.Service.HealthCheck).
// audit 블록은 감사 writer 상태(fail-closed 여부·DB 도달·쓰기 실패 수) —
// 파드를 빼지는 않고(readiness 무관) 보이게만 한다.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	k8sStatus := "connected"
	if err := h.svc.HealthCheck(r.Context()); err != nil {
		k8sStatus = "disconnected"
	}
	body := map[string]interface{}{
		"status":     "healthy",
		"kubernetes": k8sStatus,
	}
	if st, ok := h.auditStore.(audit.Statuser); ok {
		ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
		defer cancel()
		body["audit"] = st.Status(ctx)
	}
	response.JSON(w, http.StatusOK, body)
}
