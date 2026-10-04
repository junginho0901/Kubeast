package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- Audit log endpoint ---

// AdminListAuditLogs handles GET /auth/admin/audit-logs with filter query params.
// Accessible only to users holding the admin.audit.read permission.
//
// Query params: service, action, actor_email, target_id, cluster, namespace,
//
//	result, since (RFC3339), until (RFC3339), limit (default 100, max 1000),
//	offset (default 0).
//
// Logs the read itself as "admin.audit.read" (meta-audit).
func (h *AuthHandler) AdminListAuditLogs(w http.ResponseWriter, r *http.Request) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission("admin.audit.read") {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}

	filter := auditFilterFromQuery(r)

	entries, total, err := h.auditStore.List(r.Context(), filter)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}

	// Meta-audit: record who accessed the audit log and with what filter.
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.audit.read"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.After = audit.MustJSON(map[string]interface{}{
		"filter":      filter,
		"returned":    len(entries),
		"total_match": total,
	})
	_, _ = h.auditStore.Write(r.Context(), rec)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"total": total,
		"items": entries,
	})
}

// --- Helpers ---

func (h *AuthHandler) writeAuditLog(r *http.Request, action string, actorID, actorEmail, targetID, targetEmail *string, before, after *json.RawMessage) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = action
	rec.TargetType = "user"
	rec.ActorUserID = derefStr(actorID)
	rec.ActorEmail = derefStr(actorEmail)
	rec.TargetID = derefStr(targetID)
	rec.TargetEmail = derefStr(targetEmail)
	if before != nil {
		rec.Before = *before
	}
	if after != nil {
		rec.After = *after
	}

	id, err := h.auditStore.Write(r.Context(), rec)
	if err != nil {
		slog.Error("failed to create audit log", "error", err, "action", action)
		return
	}
	slog.Info("audit", "action", action, "actor", rec.ActorEmail, "target", rec.TargetEmail, "audit_id", id)
}
