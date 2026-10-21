package handler

import (
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// AdminWritesGate is audit.RequireWritable for the signed-in routes: while the
// audit store cannot take a row, admin and account writes (users, roles,
// grants, API keys, clusters, access-request decisions) are refused with 503.
// Refreshing a token, changing one's own password and the cluster-switch
// beacon still go through so people stay signed in; sign-in, sign-out and the
// API key exchange sit outside these groups and always go through.
func AdminWritesGate(store audit.Store) func(http.Handler) http.Handler {
	rd, ok := store.(audit.Readier)
	if !ok {
		return func(next http.Handler) http.Handler { return next }
	}
	return audit.RequireWritable(rd, "/api/v1/auth/refresh", "/api/v1/auth/change-password", "/api/v1/audit/cluster-switch")
}

// refuseIfUnaudited answers 503 before a sensitive read (the audit log, access
// review, AI usage, directory groups) whose row could not be stored, and
// reports whether it did.
func refuseIfUnaudited(store audit.Store, w http.ResponseWriter, r *http.Request) bool {
	rd, ok := store.(audit.Readier)
	if !ok {
		return false
	}
	if err := rd.Ready(r.Context()); err != nil {
		slog.WarnContext(r.Context(), "audit: refusing unrecorded read", "path", r.URL.Path, "error", err)
		response.Error(w, http.StatusServiceUnavailable, audit.ErrUnavailable.Error())
		return true
	}
	return false
}

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
