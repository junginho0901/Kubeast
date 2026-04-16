package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// isGatewayAPINotAvailable checks if the error indicates Gateway API CRDs are not installed.
func isGatewayAPINotAvailable(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "could not find the requested resource") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "Gateway API not available")
}

// --- Gateways ---

// GetAllGateways handles GET /api/v1/gateways/all.
func (h *Handler) GetAllGateways(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllGateways(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGateways handles GET /api/v1/namespaces/{namespace}/gateways.
func (h *Handler) GetGateways(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetGateways(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeGateway handles GET /api/v1/namespaces/{namespace}/gateways/{name}/describe.
func (h *Handler) DescribeGateway(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeGateway(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteGateway handles DELETE /api/v1/namespaces/{namespace}/gateways/{name}.
func (h *Handler) DeleteGateway(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.gateway.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteGateway(ctx, namespace, name)
	h.recordAudit(r, "k8s.gateway.delete", "gateway", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- GatewayClasses ---

// GetGatewayClasses handles GET /api/v1/gatewayclasses.
func (h *Handler) GetGatewayClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetGatewayClasses(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeGatewayClass handles GET /api/v1/gatewayclasses/{name}/describe.
func (h *Handler) DescribeGatewayClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeGatewayClass(ctx, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteGatewayClass handles DELETE /api/v1/gatewayclasses/{name}.
func (h *Handler) DeleteGatewayClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.gatewayclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteGatewayClass(ctx, name)
	h.recordAudit(r, "k8s.gatewayclass.delete", "gatewayclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- HTTPRoutes ---

// GetAllHTTPRoutes handles GET /api/v1/httproutes/all.
func (h *Handler) GetAllHTTPRoutes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllHTTPRoutes(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetHTTPRoutes handles GET /api/v1/namespaces/{namespace}/httproutes.
func (h *Handler) GetHTTPRoutes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetHTTPRoutes(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeHTTPRoute handles GET /api/v1/namespaces/{namespace}/httproutes/{name}/describe.
func (h *Handler) DescribeHTTPRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeHTTPRoute(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteHTTPRoute handles DELETE /api/v1/namespaces/{namespace}/httproutes/{name}.
func (h *Handler) DeleteHTTPRoute(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.httproute.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteHTTPRoute(ctx, namespace, name)
	h.recordAudit(r, "k8s.httproute.delete", "httproute", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- GRPCRoutes ---

// GetAllGRPCRoutes handles GET /api/v1/grpcroutes/all.
func (h *Handler) GetAllGRPCRoutes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllGRPCRoutes(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGRPCRoutes handles GET /api/v1/namespaces/{namespace}/grpcroutes.
func (h *Handler) GetGRPCRoutes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetGRPCRoutes(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeGRPCRoute handles GET /api/v1/namespaces/{namespace}/grpcroutes/{name}/describe.
func (h *Handler) DescribeGRPCRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeGRPCRoute(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteGRPCRoute handles DELETE /api/v1/namespaces/{namespace}/grpcroutes/{name}.
func (h *Handler) DeleteGRPCRoute(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.grpcroute.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteGRPCRoute(ctx, namespace, name)
	h.recordAudit(r, "k8s.grpcroute.delete", "grpcroute", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- ReferenceGrants ---

// GetAllReferenceGrants handles GET /api/v1/referencegrants/all.
func (h *Handler) GetAllReferenceGrants(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllReferenceGrants(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetReferenceGrants handles GET /api/v1/namespaces/{namespace}/referencegrants.
func (h *Handler) GetReferenceGrants(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetReferenceGrants(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeReferenceGrant handles GET /api/v1/namespaces/{namespace}/referencegrants/{name}/describe.
func (h *Handler) DescribeReferenceGrant(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeReferenceGrant(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteReferenceGrant handles DELETE /api/v1/namespaces/{namespace}/referencegrants/{name}.
func (h *Handler) DeleteReferenceGrant(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.referencegrant.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteReferenceGrant(ctx, namespace, name)
	h.recordAudit(r, "k8s.referencegrant.delete", "referencegrant", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- BackendTLSPolicies ---

// GetAllBackendTLSPolicies handles GET /api/v1/backendtlspolicies/all.
func (h *Handler) GetAllBackendTLSPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllBackendTLSPolicies(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetBackendTLSPolicies handles GET /api/v1/namespaces/{namespace}/backendtlspolicies.
func (h *Handler) GetBackendTLSPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetBackendTLSPolicies(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeBackendTLSPolicy handles GET /api/v1/namespaces/{namespace}/backendtlspolicies/{name}/describe.
func (h *Handler) DescribeBackendTLSPolicy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeBackendTLSPolicy(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteBackendTLSPolicy handles DELETE /api/v1/namespaces/{namespace}/backendtlspolicies/{name}.
func (h *Handler) DeleteBackendTLSPolicy(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.backendtlspolicy.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteBackendTLSPolicy(ctx, namespace, name)
	h.recordAudit(r, "k8s.backendtlspolicy.delete", "backendtlspolicy", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- BackendTrafficPolicies ---

// GetAllBackendTrafficPolicies handles GET /api/v1/backendtrafficpolicies/all.
func (h *Handler) GetAllBackendTrafficPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllBackendTrafficPolicies(ctx)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetBackendTrafficPolicies handles GET /api/v1/namespaces/{namespace}/backendtrafficpolicies.
func (h *Handler) GetBackendTrafficPolicies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetBackendTrafficPolicies(ctx, namespace)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusOK, []interface{}{})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeBackendTrafficPolicy handles GET /api/v1/namespaces/{namespace}/backendtrafficpolicies/{name}/describe.
func (h *Handler) DescribeBackendTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeBackendTrafficPolicy(ctx, namespace, name)
	if err != nil {
		if isGatewayAPINotAvailable(err) {
			response.JSON(w, http.StatusNotFound, map[string]string{"detail": "Gateway API not available"})
			return
		}
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteBackendTrafficPolicy handles DELETE /api/v1/namespaces/{namespace}/backendtrafficpolicies/{name}.
func (h *Handler) DeleteBackendTrafficPolicy(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.backendtrafficpolicy.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteBackendTrafficPolicy(ctx, namespace, name)
	h.recordAudit(r, "k8s.backendtrafficpolicy.delete", "backendtrafficpolicy", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
