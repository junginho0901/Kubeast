package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

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
	if err := h.requirePermissionForCluster(r, "resource.referencegrant.delete"); err != nil {
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
