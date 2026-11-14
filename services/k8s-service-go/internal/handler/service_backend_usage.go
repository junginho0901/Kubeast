package handler

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// backendUsageSource is what the sum reads: the cluster's Prometheus and the Service's EndpointSlices, as the signed-in
// user (*k8s.Service; tests replace it).
type backendUsageSource interface {
	PrometheusAvailable(ctx context.Context) bool
	ServiceBackendPods(ctx context.Context, namespace, name string) ([]string, error)
	PrometheusQuery(ctx context.Context, query string) ([]k8s.PrometheusQueryResult, error)
}

func (h *Handler) backendUsageSource() backendUsageSource {
	if h.backendUsageSrc != nil {
		return h.backendUsageSrc
	}
	return h.svc
}

// ServiceBackendUsage handles GET /api/v1/namespaces/{namespace}/services/{name}/backend-usage: the CPU, working set
// and count of the pods behind the Service's ready endpoints from the cluster's Prometheus, for a Service whose pods
// one query from the screen cannot name (k8s.SumBackendUsage). A metrics read like /prometheus/query, refused to a grant
// limited to namespaces as that is, and not audited.
func (h *Handler) ServiceBackendUsage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	src := h.backendUsageSource()
	if !src.PrometheusAvailable(ctx) {
		response.JSON(w, http.StatusOK, k8s.BackendUsage{})
		return
	}
	if !promClusterWide(w, r) {
		return
	}
	namespace, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
	pods, err := src.ServiceBackendPods(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	usage, err := k8s.SumBackendUsage(ctx, namespace, pods, src.PrometheusQuery)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, usage)
}
