package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterMetrics — metrics-server backed pod/node metrics.
//
// Prometheus-backed metrics live in gpu.go for now and will move out
// when the obs-service is split (see prereq [13]).
func RegisterMetrics(r chi.Router, h *handler.Handler) {
	r.Get("/api/v1/metrics/pods", h.GetPodMetrics)
	r.Get("/api/v1/metrics/nodes", h.GetNodeMetrics)
	// The nodes' busiest CPU and the pods that used it (features.nodeNeighbors.busiestCPU; the AI tool get_node_metrics)
	r.Get("/api/v1/metrics/nodes/busiest-cpu", h.NodeNeighbors().Busiest)
	r.Get("/api/v1/metrics/top-resources", h.GetTopResources)
}
