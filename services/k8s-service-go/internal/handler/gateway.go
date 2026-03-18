package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteGateway(ctx, namespace, name); err != nil {
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteGatewayClass(ctx, name); err != nil {
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
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteHTTPRoute(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
