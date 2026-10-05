package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Terminal session recordings (internal/recording): starting one for an exec
// or node shell, and the admin read API.
//
//   GET /api/v1/recordings/config           any signed-in user — is recording on
//   GET /api/v1/recordings?user=&cluster=&kind=   admin.sessions.read
//   GET /api/v1/recordings/{id}             admin.sessions.read
//   GET /api/v1/recordings/{id}/cast        admin.sessions.read, audited admin.session.read (format=text for the transcript)
//
// Mounted outside the cluster middleware: recordings span clusters.

const permSessionsRead = "admin.sessions.read"

// startRecording opens a recording for a terminal about to start. ok=false
// means the request was refused (recording required but unavailable) and a
// failure audit row was written; rec is nil when recording is off.
func (h *Handler) startRecording(w http.ResponseWriter, r *http.Request, kind, namespace, target, container, action, targetType string, payload map[string]interface{}) (*recording.Session, bool) {
	if !h.recorder.Enabled() {
		return nil, true
	}
	meta := recording.Meta{Kind: kind, Namespace: namespace, Target: target, Container: container, Cluster: "default"}
	if p, ok := auth.FromContext(r.Context()); ok {
		meta.UserID, meta.UserEmail = p.UserID, p.Email
	}
	if id, ok := cluster.FromContext(r.Context()); ok && id != "" {
		meta.Cluster = string(id)
	}
	meta.Width, _ = strconv.Atoi(r.URL.Query().Get("cols"))
	meta.Height, _ = strconv.Atoi(r.URL.Query().Get("rows"))
	rec, err := h.recorder.Start(r.Context(), meta)
	if err != nil {
		if !h.recorder.Required() {
			return nil, true // recording is best-effort here: the session goes on unrecorded
		}
		failed := errors.New("session recording unavailable: " + err.Error())
		_ = h.recordAuditWithPayload(r, action, targetType, target, namespace, failed, nil, audit.MustJSON(payload))
		response.Error(w, http.StatusServiceUnavailable, "session recording unavailable")
		return nil, false
	}
	payload["recording_id"] = rec.ID
	return rec, true
}

// RecordingsConfig tells the UI whether terminals are recorded.
func (h *Handler) RecordingsConfig(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]bool{"enabled": h.recorder.Enabled()})
}

func (h *Handler) ListRecordings(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, permSessionsRead); err != nil {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}
	if h.recorder == nil {
		response.JSON(w, http.StatusOK, []recording.Recording{})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := h.recorder.List(r.Context(), recording.Filter{
		User: r.URL.Query().Get("user"), Cluster: r.URL.Query().Get("cluster"), Kind: r.URL.Query().Get("kind"), Limit: limit,
	})
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, list)
}

func (h *Handler) GetRecording(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, permSessionsRead); err != nil {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}
	rec, ok := h.lookupRecording(w, r)
	if !ok {
		return
	}
	response.JSON(w, http.StatusOK, rec)
}

// GetRecordingCast returns the asciicast (or, with format=text, the plain
// transcript). Reading a recording is a sensitive read: no audit row, no body.
func (h *Handler) GetRecordingCast(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, permSessionsRead); err != nil {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return
	}
	rec, ok := h.lookupRecording(w, r)
	if !ok {
		return
	}
	format := r.URL.Query().Get("format")
	if format != "text" {
		format = "cast"
	}
	if err := h.auditReady(r); err != nil {
		h.refuseUnaudited(w, r, err)
		return
	}
	body, err := h.recorder.Cast(r.Context(), rec)
	after := map[string]interface{}{"kind": rec.Kind, "cluster": rec.Cluster, "target": rec.Target, "format": format}
	if rec.UserEmail != nil {
		after["user_email"] = *rec.UserEmail
	}
	ns := ""
	if rec.Namespace != nil {
		ns = *rec.Namespace
	}
	if werr := h.recordAuditAs(r, audit.ServiceAdmin, "admin.session.read", "session_recording", rec.ID, ns, err, nil, audit.MustJSON(after)); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	if format == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+rec.ID+`.txt"`)
		_, _ = w.Write([]byte(recording.Transcript(body)))
		return
	}
	w.Header().Set("Content-Type", "application/x-asciicast")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+rec.ID+`.cast"`)
	}
	_, _ = w.Write(body)
}

func (h *Handler) lookupRecording(w http.ResponseWriter, r *http.Request) (*recording.Recording, bool) {
	if h.recorder == nil {
		response.Error(w, http.StatusNotFound, "recording not found")
		return nil, false
	}
	rec, err := h.recorder.Get(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, recording.ErrNotFound) {
		response.Error(w, http.StatusNotFound, "recording not found")
		return nil, false
	}
	if err != nil {
		response.InternalError(w, r, err)
		return nil, false
	}
	return rec, true
}
