package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

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
	if err := h.requirePermissionForCluster(r, "resource.backendtlspolicy.delete"); err != nil {
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

// --- Gateway policies (every kind, label-discovered + built-in table) ---

// GetAllGatewayPolicies handles GET /api/v1/gateway-policies/all.
func (h *Handler) GetAllGatewayPolicies(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.GetGatewayPolicies(r.Context(), "", h.cfg.GatewayPolicyKinds)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGatewayPolicies handles GET /api/v1/namespaces/{namespace}/gateway-policies.
func (h *Handler) GetGatewayPolicies(w http.ResponseWriter, r *http.Request) {
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetGatewayPolicies(r.Context(), namespace, h.cfg.GatewayPolicyKinds)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
