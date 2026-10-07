package handler

import (
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetClusterIssues handles GET /api/v1/issues (gateway: /api/v1/cluster/issues).
// window = minutes of Warning events to read (default ISSUES_EVENT_WINDOW_MINUTES).
func (h *Handler) GetClusterIssues(w http.ResponseWriter, r *http.Request) {
	window := queryParamInt(r, "window", h.cfg.IssuesEventWindowMinutes)
	if window < 1 || window > 7*24*60 {
		window = h.cfg.IssuesEventWindowMinutes
	}
	issues, err := h.svc.CollectIssues(r.Context(), k8s.IssuesOptions{
		Window:                time.Duration(window) * time.Minute,
		IncludeRestartHistory: queryParamBool(r, "include_restart_history", false),
	})
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"window_minutes": window,
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"issues":         issues,
	})
}
