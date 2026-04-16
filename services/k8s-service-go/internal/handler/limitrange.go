package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetLimitRanges handles GET /api/v1/namespaces/{namespace}/limitranges.
func (h *Handler) GetLimitRanges(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetLimitRanges(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAllLimitRanges handles GET /api/v1/limitranges/all.
func (h *Handler) GetAllLimitRanges(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllLimitRanges(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeLimitRange handles GET /api/v1/namespaces/{namespace}/limitranges/{name}/describe.
func (h *Handler) DescribeLimitRange(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeLimitRange(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetLimitRangeYAML handles GET /api/v1/namespaces/{namespace}/limitranges/{name}/yaml.
func (h *Handler) GetLimitRangeYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "limitranges", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteLimitRange handles DELETE /api/v1/namespaces/{namespace}/limitranges/{name}.
func (h *Handler) DeleteLimitRange(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.limitrange.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteLimitRange(ctx, namespace, name)
	h.recordAudit(r, "k8s.limitrange.delete", "limitrange", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
