package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// streamEndedEvent names the event a stream's last frame carries when its session stopped standing.
const streamEndedEvent = "session-ended"

// auditSessionEndAction is the row of a terminal or followed log the server ended, next to the row that opened it.
const auditSessionEndAction = "k8s.session.end"

// holdSession ties a long-lived answer on ctx to the session of its caller (auth.LiveSessions).
func (h *Handler) holdSession(ctx context.Context) (context.Context, func()) {
	payload, _ := auth.FromContext(ctx)
	return h.liveSessions.Hold(ctx, payload)
}

// sayStreamEnded tells an event stream why it ends when that is its session, and reports whether it was.
func sayStreamEnded(ctx context.Context, w http.ResponseWriter, flusher http.Flusher) bool {
	code := auth.SessionEndCode(ctx)
	if code == "" {
		return false
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", streamEndedEvent, code); err == nil {
		flusher.Flush()
	}
	return true
}

// auditSessionEnd writes the row of a connection its session ended; other ends are the user's own and have none.
func (h *Handler) auditSessionEnd(ctx context.Context, r *http.Request, targetType, target, namespace, stream string) {
	code := auth.SessionEndCode(ctx)
	if code == "" {
		return
	}
	slog.InfoContext(r.Context(), "connection closed: session ended", "stream", stream, "target", target, "reason", code)
	_ = h.recordAuditWithPayload(r, auditSessionEndAction, targetType, target, namespace, nil, nil,
		audit.MustJSON(map[string]interface{}{"stream": stream, "reason": code}))
}
