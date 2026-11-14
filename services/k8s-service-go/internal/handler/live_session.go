package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/probe"
)

// streamEndedEvent names the event a stream's last frame carries when its session stopped standing.
const streamEndedEvent = "session-ended"

// auditSessionEndAction is the row of a terminal or followed log the server ended, next to the row that opened it.
const auditSessionEndAction = "k8s.session.end"

// leavingRetryMillis is the reconnection time a stream ended by the server leaving gives the browser's EventSource,
// which then asks again, with Last-Event-ID, through the Service to a pod that stays.
const leavingRetryMillis = 1000

// holdSession ties a long-lived answer on ctx to the session of its caller (auth.LiveSessions).
// It also ends, with probe.ErrLeaving as the cause, when the server starts to leave.
func (h *Handler) holdSession(ctx context.Context) (context.Context, func()) {
	payload, _ := auth.FromContext(ctx)
	ctx, endSession := h.liveSessions.Hold(ctx, payload)
	ctx, endHold := h.leaving.Hold(ctx)
	return ctx, func() {
		endHold()
		endSession()
	}
}

// sayStreamEnded tells an event stream why it ends when that is its session, and reports whether it was. A stream the
// server's leaving ended gets a short reconnection time instead and is not a session's end.
func sayStreamEnded(ctx context.Context, w http.ResponseWriter, flusher http.Flusher) bool {
	if probe.IsLeaving(ctx) {
		if _, err := fmt.Fprintf(w, "retry: %d\n\n", leavingRetryMillis); err == nil {
			flusher.Flush()
		}
		return false
	}
	code := auth.SessionEndCode(ctx)
	if code == "" {
		return false
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", streamEndedEvent, code); err == nil {
		flusher.Flush()
	}
	return true
}

// auditSessionEnd writes the row of a connection its session ended, and of a terminal the server's leaving closed
// (reason server_shutdown; a followed log reconnects by itself and has none). Other ends are the user's own and have none.
func (h *Handler) auditSessionEnd(ctx context.Context, r *http.Request, targetType, target, namespace, stream string) {
	code := auth.SessionEndCode(ctx)
	if code == "" && probe.IsLeaving(ctx) && (stream == "exec" || stream == "node-shell") {
		code = probe.ShutdownReason
	}
	if code == "" {
		return
	}
	slog.InfoContext(r.Context(), "connection closed: session ended", "stream", stream, "target", target, "reason", code)
	_ = h.recordAuditWithPayload(r, auditSessionEndAction, targetType, target, namespace, nil, nil,
		audit.MustJSON(map[string]interface{}{"stream": stream, "reason": code}))
}
