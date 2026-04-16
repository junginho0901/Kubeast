package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
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
	err := h.svc.DeleteConfigMap(ctx, namespace, name)
	h.recordAudit(r, "k8s.configmap.delete", "configmap", name, namespace, err)
	if err != nil {
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
	// Meta-read audit: only when the caller actually had permission to see plaintext.
	if canReveal {
		h.recordAuditWithPayload(r, "k8s.secret.reveal", "secret", name, namespace, err,
			nil, audit.MustJSON(map[string]interface{}{"via": "describe"}))
	}
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
	if canReveal {
		h.recordAuditWithPayload(r, "k8s.secret.reveal", "secret", name, namespace, err,
			nil, audit.MustJSON(map[string]interface{}{"via": "yaml"}))
	}
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
	err := h.svc.DeleteSecret(ctx, namespace, name)
	h.recordAudit(r, "k8s.secret.delete", "secret", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
