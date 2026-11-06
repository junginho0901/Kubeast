package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetClusterTimeline handles GET /api/v1/timeline — events and rollout history
// across every namespace.
func (h *Handler) GetClusterTimeline(w http.ResponseWriter, r *http.Request) {
	h.serveNamespaceTimeline(w, r, metav1.NamespaceAll)
}

// GetNamespaceTimeline handles GET /api/v1/cluster/namespaces/{namespace}/timeline
func (h *Handler) GetNamespaceTimeline(w http.ResponseWriter, r *http.Request) {
	h.serveNamespaceTimeline(w, r, chi.URLParam(r, "namespace"))
}

func (h *Handler) serveNamespaceTimeline(w http.ResponseWriter, r *http.Request, namespace string) {
	ctx := r.Context()
	hours, limit, err := timelineWindow(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	// read as the caller, so kept per identity: another user's answer is never served
	cacheKey := h.svc.IdentityCacheKey(ctx, "timeline|ns|"+namespace+"|"+r.URL.RawQuery)

	var cached interface{}
	if h.svc.Cache().Get(ctx, cacheKey, &cached) {
		response.JSON(w, http.StatusOK, cached)
		return
	}

	result, err := h.svc.GetNamespaceTimeline(ctx, namespace, hours, limit, timelineEventType(r))
	if err != nil {
		h.handleError(w, err)
		return
	}

	h.svc.Cache().Set(ctx, cacheKey, result, 30*time.Second)
	response.JSON(w, http.StatusOK, result)
}

// GetResourceTimeline handles GET /api/v1/cluster/namespaces/{namespace}/timeline/{kind}/{name}
func (h *Handler) GetResourceTimeline(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	kind := chi.URLParam(r, "kind")
	name := chi.URLParam(r, "name")
	hours, limit, err := timelineWindow(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	cacheKey := h.svc.IdentityCacheKey(ctx, "timeline|res|"+namespace+"|"+kind+"|"+name+"|"+r.URL.RawQuery)

	var cached interface{}
	if h.svc.Cache().Get(ctx, cacheKey, &cached) {
		response.JSON(w, http.StatusOK, cached)
		return
	}

	result, err := h.svc.GetResourceTimeline(ctx, namespace, kind, name, hours, limit, timelineEventType(r))
	if err != nil {
		h.handleError(w, err)
		return
	}

	h.svc.Cache().Set(ctx, cacheKey, result, 30*time.Second)
	response.JSON(w, http.StatusOK, result)
}

// timelineMaxHours is the longest window a timeline reads, the AI tool's 90 days. Far past it the hours overflow into a
// start in the future, which reads no events and answers as if there were none.
const timelineMaxHours = 90 * 24

// timelineWindow is the hours (default 24) and limit (default 500, at most eventsLimitMax) a timeline asks for; what is
// no number in its range is an error to answer with, not a window that reads nothing or a default nobody asked for.
func timelineWindow(r *http.Request) (hours, limit int, err error) {
	if hours, err = timelineNumber(r, "hours", 24, timelineMaxHours); err != nil {
		return 0, 0, err
	}
	if limit, err = timelineNumber(r, "limit", 500, eventsLimitMax); err != nil {
		return 0, 0, err
	}
	return hours, limit, nil
}

func timelineNumber(r *http.Request, key string, fallback, most int) (int, error) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > most {
		return 0, fmt.Errorf("%s must be a whole number from 1 to %d", key, most)
	}
	return n, nil
}

// timelineEventType is the events a timeline lists (type=Normal or Warning); anything else lists both.
func timelineEventType(r *http.Request) string {
	switch t := queryParam(r, "type", ""); t {
	case corev1.EventTypeNormal, corev1.EventTypeWarning:
		return t
	}
	return ""
}
