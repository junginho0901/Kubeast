package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// --- Custom Resource Definitions ---

// GetCRDs handles GET /api/v1/crds.
func (h *Handler) GetCRDs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetCRDs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeCRD handles GET /api/v1/crds/{name}/describe.
func (h *Handler) DescribeCRD(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeCRD(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteCRD handles DELETE /api/v1/crds/{name}.
func (h *Handler) DeleteCRD(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.crd.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteCRD(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- Custom Resource Instances ---

// GetAllCustomResourceInstances handles GET /api/v1/custom-resources/all.
func (h *Handler) GetAllCustomResourceInstances(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllCustomResourceInstances(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetCustomResourceInstances handles GET /api/v1/custom-resources/{group}/{version}/{plural}.
func (h *Handler) GetCustomResourceInstances(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	group := chi.URLParam(r, "group")
	version := chi.URLParam(r, "version")
	plural := chi.URLParam(r, "plural")
	data, err := h.svc.GetCustomResourceInstances(ctx, group, version, plural)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeCustomResourceInstance handles GET /api/v1/custom-resources/{group}/{version}/{plural}/{namespace}/{name}/describe.
func (h *Handler) DescribeCustomResourceInstance(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	group := chi.URLParam(r, "group")
	version := chi.URLParam(r, "version")
	plural := chi.URLParam(r, "plural")
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeCustomResourceInstance(ctx, group, version, plural, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteCustomResourceInstance handles DELETE /api/v1/custom-resources/{group}/{version}/{plural}/{namespace}/{name}.
func (h *Handler) DeleteCustomResourceInstance(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.customresource.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	group := chi.URLParam(r, "group")
	version := chi.URLParam(r, "version")
	plural := chi.URLParam(r, "plural")
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteCustomResourceInstance(ctx, group, version, plural, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
