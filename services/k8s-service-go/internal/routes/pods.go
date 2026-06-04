package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterPods — Pod list / detail / logs / exec.
func RegisterPods(r chi.Router, h *handler.Handler) {
	r.Get("/api/v1/pods/all", h.GetAllPods)
	r.Get("/api/v1/namespaces/{namespace}/pods", h.GetPods)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/describe", h.DescribePod)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/yaml", h.GetPodYAML)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logs", h.GetPodLogs)
	// SSE — 단방향 log stream 이라 WebSocket 보다 SSE 가 적합 (자동 reconnect +
	// curl 디버깅 + retry 안 함수 안 defer 가 inotify watcher 누수 해결).
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logs/stream", h.PodLogsSSE)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/rbac", h.GetPodRBAC)
	r.Delete("/api/v1/namespaces/{namespace}/pods/{pod_name}", h.DeletePod)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/exec/ws", h.PodExecWS)
}
