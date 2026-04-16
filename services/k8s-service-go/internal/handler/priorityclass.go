package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetPriorityClasses handles GET /api/v1/priorityclasses.
func (h *Handler) GetPriorityClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetPriorityClasses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribePriorityClass handles GET /api/v1/priorityclasses/{name}/describe.
func (h *Handler) DescribePriorityClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribePriorityClass(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPriorityClassYAML handles GET /api/v1/priorityclasses/{name}/yaml.
func (h *Handler) GetPriorityClassYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "priorityclasses", "", name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeletePriorityClass handles DELETE /api/v1/priorityclasses/{name}.
func (h *Handler) DeletePriorityClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.priorityclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeletePriorityClass(ctx, name)
	h.recordAudit(r, "k8s.priorityclass.delete", "priorityclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
