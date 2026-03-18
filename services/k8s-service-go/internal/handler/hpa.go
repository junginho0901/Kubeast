package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetHPAs handles GET /api/v1/namespaces/{namespace}/hpas.
func (h *Handler) GetHPAs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetGenericResources(ctx, "horizontalpodautoscalers", namespace, "")
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPDBs handles GET /api/v1/namespaces/{namespace}/pdbs.
func (h *Handler) GetPDBs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetGenericResources(ctx, "poddisruptionbudgets", namespace, "")
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
