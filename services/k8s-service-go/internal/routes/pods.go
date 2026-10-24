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
	// Log files inside the container (features.logFiles): fixed ls / tail through pods/exec.
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logfiles", h.ListLogFiles)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logfiles/content", h.GetLogFileContent)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream", h.LogFileStream)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/rbac", h.GetPodRBAC)
	// Log store search (features.logSearch): one namespace, or every namespace for an unscoped grant.
	r.Get("/api/v1/namespaces/{namespace}/logsearch", h.LogSearchNamespace)
	r.Get("/api/v1/logsearch", h.LogSearchAll)
	r.Get("/api/v1/logsearch/status", h.LogSearchStatus)
	r.Get("/api/v1/namespaces/{namespace}/logsearch/query", h.LogQLNamespace)
	r.Get("/api/v1/logsearch/query", h.LogQLAll)
	// The AI's loki_* tools, through the structured search's door: labels, patterns, LogQL (lines or series).
	r.Get("/api/v1/namespaces/{namespace}/logsearch/labels", h.LogLabelsNamespace)
	r.Get("/api/v1/logsearch/labels", h.LogLabelsAll)
	r.Get("/api/v1/namespaces/{namespace}/logsearch/patterns", h.LogPatternsNamespace)
	r.Get("/api/v1/logsearch/patterns", h.LogPatternsAll)
	r.Get("/api/v1/namespaces/{namespace}/logsearch/logql", h.LogQLSearchNamespace)
	r.Get("/api/v1/logsearch/logql", h.LogQLSearchAll)
	// The drawers' "Recent Flows" and "Network Drops" and the AI's network_flows and network_drops.
	r.Get("/api/v1/namespaces/{namespace}/networkflows", h.NetworkFlows)
	r.Get("/api/v1/namespaces/{namespace}/networkdrops", h.NetworkDrops)
	// The AI's traces_* tools (features.traceStore), through the same door: TraceQL with the scope in every filter.
	r.Get("/api/v1/namespaces/{namespace}/traces/search", h.TraceSearchNamespace)
	r.Get("/api/v1/traces/search", h.TraceSearchAll)
	r.Get("/api/v1/namespaces/{namespace}/traces/metrics", h.TraceMetricsNamespace)
	r.Get("/api/v1/traces/metrics", h.TraceMetricsAll)
	r.Get("/api/v1/namespaces/{namespace}/traces/compare", h.TraceCompareNamespace)
	r.Get("/api/v1/traces/compare", h.TraceCompareAll)
	r.Get("/api/v1/namespaces/{namespace}/traces/tags", h.TraceTagsNamespace)
	r.Get("/api/v1/traces/tags", h.TraceTagsAll)
	r.Get("/api/v1/namespaces/{namespace}/traces/trace/{traceID}", h.TraceGetNamespace)
	r.Get("/api/v1/traces/trace/{traceID}", h.TraceGetAll)
	r.Delete("/api/v1/namespaces/{namespace}/pods/{pod_name}", h.DeletePod)
	r.Get("/api/v1/namespaces/{namespace}/pods/{name}/exec/ws", h.PodExecWS)
}
