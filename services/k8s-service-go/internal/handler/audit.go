package handler

import (
	"encoding/json"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// recordAudit writes a k8s-service audit entry. It is best-effort —
// a nil auditStore or a write failure never blocks the caller.
//
// Use for simple delete/mutation endpoints where there is no meaningful
// before/after payload; call recordAuditWithPayload when those are needed.
func (h *Handler) recordAudit(r *http.Request, action, targetType, targetID, namespace string, err error) {
	h.recordAuditWithPayload(r, action, targetType, targetID, namespace, err, nil, nil)
}

// recordAuditWithPayload is the full-form audit helper supporting
// before/after snapshots (for YAML apply, rollback, values upgrade, ...).
func (h *Handler) recordAuditWithPayload(
	r *http.Request,
	action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) {
	if h == nil || h.auditStore == nil {
		return
	}

	payload, _ := auth.FromContext(r.Context())

	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceK8s
	rec.Action = action
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetID = targetID
	rec.TargetType = targetType
	rec.Namespace = namespace
	rec.Before = before
	rec.After = after
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
	} else {
		rec.Result = audit.ResultSuccess
	}

	_, _ = h.auditStore.Write(r.Context(), rec)
}
