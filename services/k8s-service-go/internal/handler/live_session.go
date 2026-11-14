package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drain"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// streamEndedEvent names the event a stream's last frame carries when its session stopped standing.
const streamEndedEvent = "session-ended"

// serverLeavingEvent names the event a stream's last frame carries when its server is being replaced (drain). The
// frame also sets the browser's reconnection time: an EventSource comes back by itself after a second, through the
// gateway, to a server that stays, and goes on after the last line it got (Last-Event-ID).
const serverLeavingEvent = "server-shutdown"

const serverLeavingRetryMs = 1000

// auditSessionEndAction is the row of a terminal or followed log the server ended, next to the row that opened it.
const auditSessionEndAction = "k8s.session.end"

// holdSession ties a long-lived answer on ctx to the session of its caller (auth.LiveSessions).
func (h *Handler) holdSession(ctx context.Context) (context.Context, func()) {
	payload, _ := auth.FromContext(ctx)
	return h.liveSessions.Hold(ctx, payload)
}

// sayStreamEnded tells an event stream why it ends when that is its session or its server leaving, and reports
// whether it was one of them.
func sayStreamEnded(ctx context.Context, w http.ResponseWriter, flusher http.Flusher) bool {
	if code := auth.SessionEndCode(ctx); code != "" {
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", streamEndedEvent, code); err == nil {
			flusher.Flush()
		}
		return true
	}
	if drain.Ended(ctx) {
		sayServerLeaving(w, flusher)
		return true
	}
	return false
}

// sayServerLeaving is the frame a followed log gets when its server is being replaced, also in place of the stream
// when one is asked of a server already leaving.
func sayServerLeaving(w http.ResponseWriter, flusher http.Flusher) {
	if _, err := fmt.Fprintf(w, "retry: %d\nevent: %s\ndata: %s\n\n", serverLeavingRetryMs, serverLeavingEvent, drain.Code); err == nil {
		flusher.Flush()
	}
}

// refuseWhileLeaving answers a new event stream asked of a server that is being replaced with the frame that sends the
// browser elsewhere, and reports whether it did. It comes before any cluster call or audit row.
func (h *Handler) refuseWhileLeaving(w http.ResponseWriter) bool {
	if !h.drain.Leaving() {
		return false
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return true
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	sayServerLeaving(w, flusher)
	return true
}

// refuseTerminalWhileLeaving answers a new terminal asked of a server that is being replaced with a 503 before the
// upgrade: no session is opened and no row written.
func (h *Handler) refuseTerminalWhileLeaving(w http.ResponseWriter) bool {
	if !h.drain.Leaving() {
		return false
	}
	http.Error(w, "server shutting down", http.StatusServiceUnavailable)
	return true
}

// auditSessionEnd writes the row of a connection the server ended — its session stopped standing, or the server is
// being replaced; other ends are the user's own and have none.
func (h *Handler) auditSessionEnd(ctx context.Context, r *http.Request, targetType, target, namespace, stream string) {
	code := auth.SessionEndCode(ctx)
	why := "connection closed: session ended"
	if code == "" && drain.Ended(ctx) {
		code, why = drain.Code, "connection closed: server shutting down"
	}
	if code == "" {
		return
	}
	slog.InfoContext(r.Context(), why, "stream", stream, "target", target, "reason", code)
	_ = h.recordAuditWithPayload(r, auditSessionEndAction, targetType, target, namespace, nil, nil,
		audit.MustJSON(map[string]interface{}{"stream": stream, "reason": code}))
}
