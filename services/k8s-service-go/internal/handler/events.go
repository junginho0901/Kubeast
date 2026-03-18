package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetEvents handles GET /api/v1/events.
func (h *Handler) GetEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := queryParam(r, "namespace", "")
	resourceName := queryParam(r, "resource_name", "")
	data, err := h.svc.GetEvents(ctx, namespace, resourceName)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetNamespaceEvents handles GET /api/v1/namespaces/{namespace}/events.
func (h *Handler) GetNamespaceEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	resourceName := queryParam(r, "resource_name", "")
	data, err := h.svc.GetEvents(ctx, namespace, resourceName)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
