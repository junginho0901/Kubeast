package handler

import (
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// auditEvent is one auth/admin write for the audit log: what was done to
// which object, its state before and after, and whether it failed.
type auditEvent struct {
	action      string
	targetType  string // "user" | "role" | "organization"
	targetID    string
	targetEmail string
	before      any // marshalled and masked when non-nil
	after       any
	err         error
}

// writeAudit records ev as actor. Best-effort: a store failure is logged and
// never changes the response (AGENTS.md audit rules).
func writeAudit(store audit.Store, r *http.Request, actor auth.TokenPayload, ev auditEvent) {
	if store == nil {
		return
	}
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAuth
	rec.Action = ev.action
	rec.TargetType = ev.targetType
	rec.TargetID = ev.targetID
	rec.TargetEmail = ev.targetEmail
	rec.ActorUserID = actor.UserID
	rec.ActorEmail = actor.Email
	if ev.before != nil {
		rec.Before = audit.MaskSensitive(audit.MustJSON(ev.before))
	}
	if ev.after != nil {
		rec.After = audit.MaskSensitive(audit.MustJSON(ev.after))
	}
	if ev.err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = ev.err.Error()
	} else {
		rec.Result = audit.ResultSuccess
	}
	if _, err := store.Write(r.Context(), rec); err != nil {
		slog.Error("failed to create audit log", "error", err, "action", ev.action)
	}
}
