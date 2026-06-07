package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

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
	if err := h.requirePermissionForCluster(r, "resource.httproute.delete"); err != nil {
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
	if err := h.requirePermissionForCluster(r, "resource.grpcroute.delete"); err != nil {
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
