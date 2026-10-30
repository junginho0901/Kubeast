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

// serveEvents answers the newest limit events (default 500, at most eventsLimitMax) with their total in X-Kubeast-Total,
// or, with with_total=1, as {"items": [...], "total": n} (the AI tool k8s_get_events reads that).
func (h *Handler) serveEvents(w http.ResponseWriter, r *http.Request, namespace string) {
	limit := queryParamInt(r, "limit", 500)
	if limit < 1 || limit > eventsLimitMax {
		limit = eventsLimitMax
	}
	data, total, err := h.svc.GetEvents(r.Context(), namespace, queryParam(r, "resource_name", ""), queryParam(r, "field_selector", ""), limit)
	if err != nil {
		h.handleError(w, err)
		return
	}
	w.Header().Set("X-Kubeast-Total", strconv.Itoa(total))
	if queryParam(r, "with_total", "") == "1" {
		response.JSON(w, http.StatusOK, map[string]interface{}{"items": data, "total": total})
		return
	}
	response.JSON(w, http.StatusOK, data)
}
