package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetMutatingWebhookConfigurations handles GET /api/v1/mutatingwebhookconfigurations.
func (h *Handler) GetMutatingWebhookConfigurations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetMutatingWebhookConfigurations(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeMutatingWebhookConfiguration handles GET /api/v1/mutatingwebhookconfigurations/{name}/describe.
func (h *Handler) DescribeMutatingWebhookConfiguration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeMutatingWebhookConfiguration(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetMutatingWebhookConfigurationYAML handles GET /api/v1/mutatingwebhookconfigurations/{name}/yaml.
func (h *Handler) GetMutatingWebhookConfigurationYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "mutatingwebhookconfigurations", "", name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteMutatingWebhookConfiguration handles DELETE /api/v1/mutatingwebhookconfigurations/{name}.
func (h *Handler) DeleteMutatingWebhookConfiguration(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.mutatingwebhookconfiguration.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteMutatingWebhookConfiguration(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// GetValidatingWebhookConfigurations handles GET /api/v1/validatingwebhookconfigurations.
func (h *Handler) GetValidatingWebhookConfigurations(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetValidatingWebhookConfigurations(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeValidatingWebhookConfiguration handles GET /api/v1/validatingwebhookconfigurations/{name}/describe.
func (h *Handler) DescribeValidatingWebhookConfiguration(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeValidatingWebhookConfiguration(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetValidatingWebhookConfigurationYAML handles GET /api/v1/validatingwebhookconfigurations/{name}/yaml.
func (h *Handler) GetValidatingWebhookConfigurationYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "validatingwebhookconfigurations", "", name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeleteValidatingWebhookConfiguration handles DELETE /api/v1/validatingwebhookconfigurations/{name}.
func (h *Handler) DeleteValidatingWebhookConfiguration(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.validatingwebhookconfiguration.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	if err := h.svc.DeleteValidatingWebhookConfiguration(ctx, name); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
