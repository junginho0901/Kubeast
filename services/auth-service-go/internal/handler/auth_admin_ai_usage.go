package handler

import (
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// AdminAIUsage handles GET /auth/admin/ai-usage?since&until&group=user|model|cluster.
// It aggregates the ai.chat.complete audit records (one per chat turn: token
// usage, tool calls, duration) so an operator can see who used the AI how much.
// There is no quota; this is the visibility half of OWASP LLM10.
//
// Defaults: since = now-30d, until = now, group = user. Requires
// admin.audit.read and, like the audit-log list, records the read itself.
func (h *AuthHandler) AdminAIUsage(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.audit.read")
	if !ok {
		return
	}

	q := r.URL.Query()
	now := time.Now().UTC()
	since, until := now.Add(-30*24*time.Hour), now
	if s := q.Get("since"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "since must be RFC3339")
			return
		}
		since = t
	}
	if s := q.Get("until"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "until must be RFC3339")
			return
		}
		until = t
	}
	group := q.Get("group")
	if group == "" {
		group = "user"
	}

	rows, err := h.repo.AIUsage(r.Context(), since, until, group)
	if err != nil {
		if group != "user" && group != "model" && group != "cluster" {
			response.Error(w, http.StatusBadRequest, "group must be user, model or cluster")
			return
		}
		response.InternalError(w, r, err)
		return
	}

	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.audit.read"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "ai-usage"
	rec.After = audit.MustJSON(map[string]interface{}{
		"since": since, "until": until, "group": group, "rows": len(rows),
	})
	_, _ = h.auditStore.Write(r.Context(), rec)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"since": since.Format(time.RFC3339),
		"until": until.Format(time.RFC3339),
		"group": group,
		"rows":  rows,
	})
}
