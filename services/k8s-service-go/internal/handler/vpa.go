package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetVPAs handles GET /api/v1/namespaces/{namespace}/vpas.
func (h *Handler) GetVPAs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetVPAs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAllVPAs handles GET /api/v1/vpas/all.
func (h *Handler) GetAllVPAs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllVPAs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeVPA handles GET /api/v1/namespaces/{namespace}/vpas/{name}/describe.
func (h *Handler) DescribeVPA(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeVPA(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetVPAYAML handles GET /api/v1/namespaces/{namespace}/vpas/{name}/yaml.
func (h *Handler) GetVPAYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "verticalpodautoscalers", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteVPA handles DELETE /api/v1/namespaces/{namespace}/vpas/{name}.
func (h *Handler) DeleteVPA(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteVPA(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
