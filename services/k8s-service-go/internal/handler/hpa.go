package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetHPAs handles GET /api/v1/namespaces/{namespace}/hpas.
func (h *Handler) GetHPAs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetHPAs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAllHPAs handles GET /api/v1/hpas/all.
func (h *Handler) GetAllHPAs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllHPAs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeHPA handles GET /api/v1/namespaces/{namespace}/hpas/{name}/describe.
func (h *Handler) DescribeHPA(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeHPA(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetHPAYAML handles GET /api/v1/namespaces/{namespace}/hpas/{name}/yaml.
func (h *Handler) GetHPAYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "horizontalpodautoscalers", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteHPA handles DELETE /api/v1/namespaces/{namespace}/hpas/{name}.
func (h *Handler) DeleteHPA(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.hpa.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteHPA(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// GetPDBs handles GET /api/v1/namespaces/{namespace}/pdbs.
func (h *Handler) GetPDBs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetPDBs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetAllPDBs handles GET /api/v1/pdbs/all.
func (h *Handler) GetAllPDBs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllPDBs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribePDB handles GET /api/v1/namespaces/{namespace}/pdbs/{name}/describe.
func (h *Handler) DescribePDB(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribePDB(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPDBYAML handles GET /api/v1/namespaces/{namespace}/pdbs/{name}/yaml.
func (h *Handler) GetPDBYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "poddisruptionbudgets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeletePDB handles DELETE /api/v1/namespaces/{namespace}/pdbs/{name}.
func (h *Handler) DeletePDB(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.pdb.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeletePDB(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
