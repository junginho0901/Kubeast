package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterStreams — the connections that stay open for minutes or hours: the terminals (pod exec, node shell) and the
// followed logs (a container's output, a log file inside it). The gateway gives each of these paths a location of its
// own with a long read timeout (helm/kubeast/files/nginx.conf), so a role "stream" server can take them alone.
func RegisterStreams(r chi.Router, h *handler.Handler) {
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/exec/ws", h.PodExecWS)
	// SSE — 단방향 log stream 이라 WebSocket 보다 SSE 가 적합 (자동 reconnect +
	// curl 디버깅 + retry 안 함수 안 defer 가 inotify watcher 누수 해결).
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logs/stream", h.PodLogsSSE)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream", h.LogFileStream)
	r.Get("/api/v1/nodes/{name}/debug-shell/ws", h.NodeDebugShellWS)
}
