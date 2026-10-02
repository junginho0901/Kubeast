package routes

import (
	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
)

// RegisterGateway — Gateway API resources (Gateway, GatewayClass,
// HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy) plus the
// implementation-neutral policy listing (gateway-policies). Distinct from
// network.go because the Gateway API is its own gateway.networking.k8s.io
// group with its own RBAC and CRD lifecycle.
func RegisterGateway(r chi.Router, h *handler.Handler) {
	// Gateways
	r.Get("/api/v1/gateways/all", h.GetAllGateways)
	r.Get("/api/v1/namespaces/{namespace}/gateways", h.GetGateways)
	r.Get("/api/v1/namespaces/{namespace}/gateways/{name}/describe", h.DescribeGateway)
	r.Delete("/api/v1/namespaces/{namespace}/gateways/{name}", h.DeleteGateway)

	// GatewayClasses
	r.Get("/api/v1/gatewayclasses", h.GetGatewayClasses)
	r.Get("/api/v1/gatewayclasses/{name}/describe", h.DescribeGatewayClass)
	r.Delete("/api/v1/gatewayclasses/{name}", h.DeleteGatewayClass)

	// HTTPRoutes
	r.Get("/api/v1/httproutes/all", h.GetAllHTTPRoutes)
	r.Get("/api/v1/namespaces/{namespace}/httproutes", h.GetHTTPRoutes)
	r.Get("/api/v1/namespaces/{namespace}/httproutes/{name}/describe", h.DescribeHTTPRoute)
	r.Delete("/api/v1/namespaces/{namespace}/httproutes/{name}", h.DeleteHTTPRoute)

	// GRPCRoutes
	r.Get("/api/v1/grpcroutes/all", h.GetAllGRPCRoutes)
	r.Get("/api/v1/namespaces/{namespace}/grpcroutes", h.GetGRPCRoutes)
	r.Get("/api/v1/namespaces/{namespace}/grpcroutes/{name}/describe", h.DescribeGRPCRoute)
	r.Delete("/api/v1/namespaces/{namespace}/grpcroutes/{name}", h.DeleteGRPCRoute)

	// ReferenceGrants
	r.Get("/api/v1/referencegrants/all", h.GetAllReferenceGrants)
	r.Get("/api/v1/namespaces/{namespace}/referencegrants", h.GetReferenceGrants)
	r.Get("/api/v1/namespaces/{namespace}/referencegrants/{name}/describe", h.DescribeReferenceGrant)
	r.Delete("/api/v1/namespaces/{namespace}/referencegrants/{name}", h.DeleteReferenceGrant)

	// BackendTLSPolicies
	r.Get("/api/v1/backendtlspolicies/all", h.GetAllBackendTLSPolicies)
	r.Get("/api/v1/namespaces/{namespace}/backendtlspolicies", h.GetBackendTLSPolicies)
	r.Get("/api/v1/namespaces/{namespace}/backendtlspolicies/{name}/describe", h.DescribeBackendTLSPolicy)
	r.Delete("/api/v1/namespaces/{namespace}/backendtlspolicies/{name}", h.DeleteBackendTLSPolicy)

	// Gateway policies of every implementation (read-only list; the drawer
	// uses the custom-resources routes for describe / YAML / delete)
	r.Get("/api/v1/gateway-policies/all", h.GetAllGatewayPolicies)
	r.Get("/api/v1/namespaces/{namespace}/gateway-policies", h.GetGatewayPolicies)
}
