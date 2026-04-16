package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetAllDeployments handles GET /api/v1/deployments/all.
func (h *Handler) GetAllDeployments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllDeployments(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDeployments handles GET /api/v1/namespaces/{namespace}/deployments.
func (h *Handler) GetDeployments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetDeployments(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeDeployment handles GET /api/v1/namespaces/{namespace}/deployments/{name}/describe.
func (h *Handler) DescribeDeployment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeDeployment(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDeploymentYAML handles GET /api/v1/namespaces/{namespace}/deployments/{name}/yaml.
func (h *Handler) GetDeploymentYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "deployments", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteDeployment handles DELETE /api/v1/namespaces/{namespace}/deployments/{deployment_name}.
func (h *Handler) DeleteDeployment(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.deployment.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "deployment_name")
	err := h.svc.DeleteDeployment(ctx, namespace, name)
	h.recordAudit(r, "k8s.deployment.delete", "deployment", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
