package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllReplicaSets handles GET /api/v1/replicasets/all.
func (h *Handler) GetAllReplicaSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllReplicaSets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetReplicaSets handles GET /api/v1/namespaces/{namespace}/replicasets.
func (h *Handler) GetReplicaSets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetReplicaSets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeReplicaSet handles GET /api/v1/namespaces/{namespace}/replicasets/{name}/describe.
func (h *Handler) DescribeReplicaSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeReplicaSet(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetReplicaSetYAML handles GET /api/v1/namespaces/{namespace}/replicasets/{name}/yaml.
func (h *Handler) GetReplicaSetYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "replicasets", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteReplicaSet handles DELETE /api/v1/namespaces/{namespace}/replicasets/{name}.
func (h *Handler) DeleteReplicaSet(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.replicaset.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteReplicaSet(ctx, namespace, name)
	h.recordAudit(r, "k8s.replicaset.delete", "replicaset", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
