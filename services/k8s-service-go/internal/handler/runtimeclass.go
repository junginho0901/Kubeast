package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetRuntimeClasses handles GET /api/v1/runtimeclasses.
func (h *Handler) GetRuntimeClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetRuntimeClasses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeRuntimeClass handles GET /api/v1/runtimeclasses/{name}/describe.
func (h *Handler) DescribeRuntimeClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeRuntimeClass(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetRuntimeClassYAML handles GET /api/v1/runtimeclasses/{name}/yaml.
func (h *Handler) GetRuntimeClassYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "runtimeclasses", "", name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteRuntimeClass handles DELETE /api/v1/runtimeclasses/{name}.
func (h *Handler) DeleteRuntimeClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.runtimeclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteRuntimeClass(ctx, name)
	h.recordAudit(r, "k8s.runtimeclass.delete", "runtimeclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
