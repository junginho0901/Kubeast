package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterGPU — GPU dashboard / metrics, Prometheus integration (until
// the obs-service split per [13]), and DRA (Dynamic Resource
// Allocation) resources. DRA lives here because the GPU UI is its
// primary consumer.
func RegisterGPU(r chi.Router, h *handler.Handler) {
	// GPU
	r.Get("/api/v1/gpu/dashboard", h.GetGPUDashboard)
	r.Get("/api/v1/gpu/metrics", h.GetGPUMetrics)

	// Prometheus integration
	r.Get("/api/v1/prometheus/status", h.GetPrometheusStatus)
	r.Get("/api/v1/prometheus/query", h.PrometheusQuery)
	r.Get("/api/v1/prometheus/query_range", h.PrometheusQueryRange)

	// DRA - DeviceClasses (cluster-scoped)
	r.Get("/api/v1/deviceclasses", h.GetDeviceClasses)
	r.Get("/api/v1/deviceclasses/{name}/describe", h.DescribeDeviceClass)
	r.Delete("/api/v1/deviceclasses/{name}", h.DeleteDeviceClass)

	// DRA - ResourceClaims (namespace-scoped)
	r.Get("/api/v1/resourceclaims/all", h.GetAllResourceClaims)
	r.Get("/api/v1/namespaces/{namespace}/resourceclaims", h.GetResourceClaims)
	r.Get("/api/v1/namespaces/{namespace}/resourceclaims/{name}/describe", h.DescribeResourceClaim)
	r.Delete("/api/v1/namespaces/{namespace}/resourceclaims/{name}", h.DeleteResourceClaim)

	// DRA - ResourceClaimTemplates (namespace-scoped)
	r.Get("/api/v1/resourceclaimtemplates/all", h.GetAllResourceClaimTemplates)
	r.Get("/api/v1/namespaces/{namespace}/resourceclaimtemplates", h.GetResourceClaimTemplates)
	r.Get("/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}/describe", h.DescribeResourceClaimTemplate)
	r.Delete("/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}", h.DeleteResourceClaimTemplate)

	// DRA - ResourceSlices (cluster-scoped)
	r.Get("/api/v1/resourceslices", h.GetResourceSlices)
	r.Get("/api/v1/resourceslices/{name}/describe", h.DescribeResourceSlice)
	r.Delete("/api/v1/resourceslices/{name}", h.DeleteResourceSlice)
}
