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
	h.recordAuditAs(r, audit.ServiceK8s, action, targetType, targetID, namespace, err, before, after)
}

// recordHelmAudit is the helm-scoped counterpart to recordAudit. It
// fixes Service=ServiceHelm so helm handlers do not have to spell out
// the boilerplate (see docs/helm-plan.md §8-6 option B).
func (h *Handler) recordHelmAudit(
	r *http.Request,
	action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) {
	h.recordAuditAs(r, audit.ServiceHelm, action, targetType, targetID, namespace, err, before, after)
}

// recordAuditAs is the shared implementation that lets callers pin the
// audit Service field. Every helper above funnels through it so the
// record shape stays identical across k8s-service and helm actions.
func (h *Handler) recordAuditAs(
	r *http.Request,
	service, action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) {
	if h == nil || h.auditStore == nil {
		return
	}

	payload, _ := auth.FromContext(r.Context())

	rec := audit.FromHTTPRequest(r)
	rec.Service = service
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
