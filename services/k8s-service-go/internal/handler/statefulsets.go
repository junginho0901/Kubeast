package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllStatefulSets handles GET /api/v1/statefulsets/all.
func (h *Handler) GetAllStatefulSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllStatefulSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStatefulSets handles GET /api/v1/namespaces/{namespace}/statefulsets.
func (h *Handler) GetStatefulSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetStatefulSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeStatefulSet handles GET /api/v1/namespaces/{namespace}/statefulsets/{name}/describe.
func (h *Handler) DescribeStatefulSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeStatefulSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStatefulSetYAML handles GET /api/v1/namespaces/{namespace}/statefulsets/{name}/yaml.
func (h *Handler) GetStatefulSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "statefulsets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteStatefulSet handles DELETE /api/v1/namespaces/{namespace}/statefulsets/{name}.
func (h *Handler) DeleteStatefulSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.statefulset.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteStatefulSet(ctx, namespace, name)
	h.recordAudit(r, "k8s.statefulset.delete", "statefulset", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
