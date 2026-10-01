package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// recordAudit writes a k8s-service audit entry and reports whether the row
// was stored. Mutation handlers call it after the change and may ignore the
// result (the store counts and logs the failure); sensitive reads must not
// answer when it fails — see auditReady / refuseUnaudited.
//
// Use for simple delete/mutation endpoints where there is no meaningful
// before/after payload; call recordAuditWithPayload when those are needed.
func (h *Handler) recordAudit(r *http.Request, action, targetType, targetID, namespace string, err error) error {
	return h.recordAuditWithPayload(r, action, targetType, targetID, namespace, err, nil, nil)
}

// recordAuditWithPayload is the full-form audit helper supporting
// before/after snapshots (for YAML apply, rollback, values upgrade, ...).
func (h *Handler) recordAuditWithPayload(
	r *http.Request,
	action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) error {
	return h.recordAuditAs(r, audit.ServiceK8s, action, targetType, targetID, namespace, err, before, after)
}

// recordHelmAudit is the helm-scoped counterpart to recordAudit. It
// fixes Service=ServiceHelm so helm handlers do not have to spell out
// the boilerplate (see docs/helm-plan.md §8-6 option B).
func (h *Handler) recordHelmAudit(
	r *http.Request,
	action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) error {
	return h.recordAuditAs(r, audit.ServiceHelm, action, targetType, targetID, namespace, err, before, after)
}

// recordAuditAs is the shared implementation that lets callers pin the
// audit Service field. Every helper above funnels through it so the
// record shape stays identical across k8s-service and helm actions.
func (h *Handler) recordAuditAs(
	r *http.Request,
	service, action, targetType, targetID, namespace string,
	err error,
	before, after json.RawMessage,
) error {
	if h == nil || h.auditStore == nil {
		return nil
	}

	payload, _ := auth.FromContext(r.Context())

	rec := audit.FromHTTPRequest(r)
	rec.Service = service
	rec.Action = action
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	if id, ok := cluster.FromContext(r.Context()); ok { // which cluster the object lives in
		rec.Cluster = string(id)
	}
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

	_, werr := h.auditStore.Write(r.Context(), rec)
	return werr
}

// auditReady says whether a sensitive action may run now. With a fail-closed
// store (audit.Guarded) that is a cached ping of the database; plain writers,
// and a nil store in tests, always pass. Mutation routes get the same check
// from audit.RequireWritable in main.go; the audited GET paths (Secret and
// Helm reveal, logs, exec, node shell, kubeconfig) call this themselves
// because only some of their requests are sensitive.
func (h *Handler) auditReady(r *http.Request) error {
	if h == nil || h.auditStore == nil {
		return nil
	}
	if rd, ok := h.auditStore.(audit.Readier); ok {
		return rd.Ready(r.Context())
	}
	return nil
}

// refuseUnaudited answers 503 "audit unavailable" for a sensitive action the
// store could not record and logs the reason (an auditReady error or a raw
// Write error — both may name the database host, so neither is sent back).
func (h *Handler) refuseUnaudited(w http.ResponseWriter, r *http.Request, err error) {
	slog.WarnContext(r.Context(), "audit: refusing unrecorded action", "method", r.Method, "path", r.URL.Path, "error", err)
	response.Error(w, http.StatusServiceUnavailable, audit.ErrUnavailable.Error())
}
