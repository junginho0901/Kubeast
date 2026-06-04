package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

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
