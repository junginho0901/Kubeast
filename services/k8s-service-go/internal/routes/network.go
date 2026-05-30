package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterNetwork — Service, Ingress, IngressClass, Endpoints,
// EndpointSlice, NetworkPolicy. Gateway-API resources live in
// gateway.go.
func RegisterNetwork(r chi.Router, h *handler.Handler) {
	// Services
	r.Get("/api/v1/services/all", h.GetAllServices)
	r.Get("/api/v1/namespaces/{namespace}/services", h.GetServices)
	r.Get("/api/v1/namespaces/{namespace}/services/{name}/describe", h.DescribeService)
	r.Get("/api/v1/namespaces/{namespace}/services/{name}/yaml", h.GetServiceYAML)
	r.Delete("/api/v1/namespaces/{namespace}/services/{name}", h.DeleteService)
	r.Get("/api/v1/namespaces/{namespace}/services/{service_name}/connectivity", h.CheckServiceConnectivity)

	// Ingresses
	r.Get("/api/v1/ingresses/all", h.GetAllIngresses)
	r.Get("/api/v1/namespaces/{namespace}/ingresses", h.GetIngresses)
	r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/describe", h.DescribeIngress)
	r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/detail", h.GetIngressDetail)
	r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/yaml", h.GetIngressYAML)
	r.Delete("/api/v1/namespaces/{namespace}/ingresses/{name}", h.DeleteIngress)

	// IngressClasses
	r.Get("/api/v1/ingressclasses", h.GetIngressClasses)
	r.Get("/api/v1/ingressclasses/{name}/describe", h.DescribeIngressClass)
	r.Get("/api/v1/ingressclasses/{name}/ingresses", h.ListIngressesByClass)
	r.Delete("/api/v1/ingressclasses/{name}", h.DeleteIngressClass)

	// Endpoints
	r.Get("/api/v1/endpoints/all", h.GetAllEndpoints)
	r.Get("/api/v1/namespaces/{namespace}/endpoints", h.GetEndpoints)
	r.Get("/api/v1/namespaces/{namespace}/endpoints/{name}/describe", h.DescribeEndpoints)
	r.Get("/api/v1/namespaces/{namespace}/endpoints/{name}/yaml", h.GetEndpointsYAML)
	r.Delete("/api/v1/namespaces/{namespace}/endpoints/{name}", h.DeleteEndpoints)

	// EndpointSlices
	r.Get("/api/v1/endpointslices/all", h.GetAllEndpointSlices)
	r.Get("/api/v1/namespaces/{namespace}/endpointslices", h.GetEndpointSlices)
	r.Get("/api/v1/namespaces/{namespace}/endpointslices/{name}/describe", h.DescribeEndpointSlice)
	r.Get("/api/v1/namespaces/{namespace}/endpointslices/{name}/yaml", h.GetEndpointSliceYAML)
	r.Delete("/api/v1/namespaces/{namespace}/endpointslices/{name}", h.DeleteEndpointSlice)

	// NetworkPolicies
	r.Get("/api/v1/networkpolicies/all", h.GetAllNetworkPolicies)
	r.Get("/api/v1/namespaces/{namespace}/networkpolicies", h.GetNetworkPolicies)
	r.Get("/api/v1/namespaces/{namespace}/networkpolicies/{name}/describe", h.DescribeNetworkPolicy)
	r.Get("/api/v1/namespaces/{namespace}/networkpolicies/{name}/yaml", h.GetNetworkPolicyYAML)
	r.Delete("/api/v1/namespaces/{namespace}/networkpolicies/{name}", h.DeleteNetworkPolicy)
}
