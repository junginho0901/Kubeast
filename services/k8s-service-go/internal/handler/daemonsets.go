package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllDaemonSets handles GET /api/v1/daemonsets/all.
func (h *Handler) GetAllDaemonSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllDaemonSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDaemonSets handles GET /api/v1/namespaces/{namespace}/daemonsets.
func (h *Handler) GetDaemonSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetDaemonSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeDaemonSet handles GET /api/v1/namespaces/{namespace}/daemonsets/{name}/describe.
func (h *Handler) DescribeDaemonSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeDaemonSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDaemonSetYAML handles GET /api/v1/namespaces/{namespace}/daemonsets/{name}/yaml.
func (h *Handler) GetDaemonSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "daemonsets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteDaemonSet handles DELETE /api/v1/namespaces/{namespace}/daemonsets/{name}.
func (h *Handler) DeleteDaemonSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.daemonset.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteDaemonSet(ctx, namespace, name)
	h.recordAudit(r, "k8s.daemonset.delete", "daemonset", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
