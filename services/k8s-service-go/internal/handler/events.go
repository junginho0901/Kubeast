package handler

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// eventsLimitMax: the most events one answer lists (newest first); X-Kubeast-Total says how many there are.
const eventsLimitMax = 5000

// GetEvents handles GET /api/v1/events.
func (h *Handler) GetEvents(w http.ResponseWriter, r *http.Request) {
	h.serveEvents(w, r, queryParam(r, "namespace", ""))
}

// GetNamespaceEvents handles GET /api/v1/namespaces/{namespace}/events.
func (h *Handler) GetNamespaceEvents(w http.ResponseWriter, r *http.Request) {
	h.serveEvents(w, r, chi.URLParam(r, "namespace"))
}

// serveEvents answers the newest limit events (default 500, at most eventsLimitMax) with their total in X-Kubeast-Total.
func (h *Handler) serveEvents(w http.ResponseWriter, r *http.Request, namespace string) {
	limit := queryParamInt(r, "limit", 500)
	if limit < 1 || limit > eventsLimitMax {
		limit = eventsLimitMax
	}
	data, total, err := h.svc.GetEvents(r.Context(), namespace, queryParam(r, "resource_name", ""), limit)
	if err != nil {
		h.handleError(w, err)
		return
	}
	w.Header().Set("X-Kubeast-Total", strconv.Itoa(total))
	response.JSON(w, http.StatusOK, data)
}
