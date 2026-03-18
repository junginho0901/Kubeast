package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetNamespaceTopology handles GET /api/v1/topology/namespace/{namespace}.
func (h *Handler) GetNamespaceTopology(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetNamespaceTopology(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetServiceTopology handles GET /api/v1/topology/service/{namespace}/{service_name}.
func (h *Handler) GetServiceTopology(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	serviceName := chi.URLParam(r, "service_name")
	data, err := h.svc.GetServiceTopology(ctx, namespace, serviceName)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetDeploymentTopology handles GET /api/v1/topology/deployment/{namespace}/{deployment_name}.
func (h *Handler) GetDeploymentTopology(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	deploymentName := chi.URLParam(r, "deployment_name")
	data, err := h.svc.GetDeploymentTopology(ctx, namespace, deploymentName)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStorageTopology handles GET /api/v1/topology/storage.
func (h *Handler) GetStorageTopology(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetStorageTopology(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
