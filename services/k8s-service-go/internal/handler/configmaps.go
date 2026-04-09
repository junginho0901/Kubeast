package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetAllConfigMaps handles GET /api/v1/configmaps/all.
func (h *Handler) GetAllConfigMaps(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllConfigMaps(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetConfigMaps handles GET /api/v1/namespaces/{namespace}/configmaps.
func (h *Handler) GetConfigMaps(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetConfigMaps(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetConfigMapYAML handles GET /api/v1/namespaces/{namespace}/configmaps/{name}/yaml.
func (h *Handler) GetConfigMapYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetConfigMapYAML(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DescribeConfigMap handles GET /api/v1/namespaces/{namespace}/configmaps/{name}/describe.
func (h *Handler) DescribeConfigMap(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeConfigMap(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteConfigMap handles DELETE /api/v1/namespaces/{namespace}/configmaps/{name}.
func (h *Handler) DeleteConfigMap(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.configmap.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteConfigMap(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// GetAllSecrets handles GET /api/v1/secrets/all.
func (h *Handler) GetAllSecrets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllSecrets(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetSecrets handles GET /api/v1/namespaces/{namespace}/secrets.
func (h *Handler) GetSecrets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetSecrets(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeSecret handles GET /api/v1/namespaces/{namespace}/secrets/{name}/describe.
func (h *Handler) DescribeSecret(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	canReveal := h.requirePermission(r, "resource.secret.reveal") == nil
	data, err := h.svc.DescribeSecret(ctx, namespace, name, canReveal)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetSecretYAML handles GET /api/v1/namespaces/{namespace}/secrets/{name}/yaml.
func (h *Handler) GetSecretYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	canReveal := h.requirePermission(r, "resource.secret.reveal") == nil
	data, err := h.svc.GetSecretYAML(ctx, namespace, name, canReveal)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteSecret handles DELETE /api/v1/namespaces/{namespace}/secrets/{name}.
func (h *Handler) DeleteSecret(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.secret.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteSecret(ctx, namespace, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
