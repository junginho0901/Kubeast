package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetNamespaces handles GET /api/v1/namespaces.
func (h *Handler) GetNamespaces(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetNamespaces(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeNamespace handles GET /api/v1/namespaces/{namespace}/describe.
func (h *Handler) DescribeNamespace(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.DescribeNamespace(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNamespaceYAML handles GET /api/v1/namespaces/{namespace}/yaml.
func (h *Handler) GetNamespaceYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetNamespaceYAML(ctx, namespace, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// ApplyNamespaceYAML handles POST /api/v1/namespaces/{namespace}/yaml/apply.
func (h *Handler) ApplyNamespaceYAML(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")

	var body struct {
		YAML string `json:"yaml"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	data, err := h.svc.ApplyNamespaceYAML(ctx, namespace, body.YAML)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// CreateNamespace handles POST /api/v1/namespaces.
func (h *Handler) CreateNamespace(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()

	var body struct {
		Name   string            `json:"name"`
		Labels map[string]string `json:"labels"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if body.Name == "" {
		response.Error(w, http.StatusBadRequest, "name is required")
		return
	}

	data, err := h.svc.CreateNamespace(ctx, body.Name, body.Labels)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusCreated, data)
}

// DeleteNamespace handles DELETE /api/v1/namespaces/{namespace}.
func (h *Handler) DeleteNamespace(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")

	if err := h.svc.DeleteNamespace(ctx, namespace); err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// GetNamespaceResourceQuotas handles GET /api/v1/namespaces/{namespace}/resource-quotas.
func (h *Handler) GetNamespaceResourceQuotas(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetNamespaceResourceQuotas(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNamespaceLimitRanges handles GET /api/v1/namespaces/{namespace}/limit-ranges.
func (h *Handler) GetNamespaceLimitRanges(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetNamespaceLimitRanges(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNamespaceOwnedPods handles GET /api/v1/namespaces/{namespace}/owned-pods.
func (h *Handler) GetNamespaceOwnedPods(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetNamespaceOwnedPods(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
