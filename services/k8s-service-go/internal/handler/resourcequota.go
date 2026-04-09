package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetResourceQuotas handles GET /api/v1/namespaces/{namespace}/resourcequotas.
func (h *Handler) GetResourceQuotas(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetResourceQuotas(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAllResourceQuotas handles GET /api/v1/resourcequotas/all.
func (h *Handler) GetAllResourceQuotas(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllResourceQuotas(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeResourceQuota handles GET /api/v1/namespaces/{namespace}/resourcequotas/{name}/describe.
func (h *Handler) DescribeResourceQuota(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeResourceQuota(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetResourceQuotaYAML handles GET /api/v1/namespaces/{namespace}/resourcequotas/{name}/yaml.
func (h *Handler) GetResourceQuotaYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "resourcequotas", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteResourceQuota handles DELETE /api/v1/namespaces/{namespace}/resourcequotas/{name}.
func (h *Handler) DeleteResourceQuota(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.resourcequota.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteResourceQuota(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
