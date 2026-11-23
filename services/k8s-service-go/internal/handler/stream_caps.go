package handler

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/streamcap"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// followedLogLimitRetryMs is the reconnection time a followed log refused at a cap gives the browser. The
// console closes the stream on the event; a page from before the event existed asks again after this, not after the
// browser's few seconds.
const followedLogLimitRetryMs = 30000

// StreamCaps are the server's counts of each account's open terminals and followed logs, for its metrics.
func (h *Handler) StreamCaps() *streamcap.Caps { return h.streamCaps }

// streamAccount is the account a terminal or a followed log is counted for: the signed-in person, whose API keys count
// with their sign-ins.
func streamAccount(r *http.Request) string {
	payload, _ := auth.FromContext(r.Context())
	return payload.UserID
}

func streamCapError(what, value string, n int) error {
	return fmt.Errorf("%s: this account has %d open on this server, the most it may (multicluster.%s)", what, n, value)
}

func serverStreamCapError(what string, n int) error {
	return fmt.Errorf("%s: this server has %d terminals and followed logs open, the most it may (multicluster.maxStreamsPerServer)", what, n)
}

// takeTerminal holds one of the account's terminal places on this server (MAX_TERMINALS_PER_ACCOUNT), and one of the
// server's (MAX_STREAMS_PER_SERVER), before the terminal opens and returns the release, which the handler defers so the
// place comes back however the terminal ends. Past either cap no session, recording or pod is made: failed writes the
// action's failed row, the socket is opened only to be closed with streamcap.CloseCode and streamcap.TerminalReason (the
// account's cap) or streamcap.ServerReason (the server's), which the screen reads as why, and ok is false.
func (h *Handler) takeTerminal(w http.ResponseWriter, r *http.Request, upgrader *websocket.Upgrader, failed func(error)) (release func(), ok bool) {
	release, refusal := h.streamCaps.Try(streamAccount(r), streamcap.Terminal)
	if refusal == streamcap.Taken {
		return release, true
	}
	err := streamCapError("terminals", "maxTerminalsPerAccount", h.streamCaps.Max(streamcap.Terminal))
	reason := streamcap.TerminalReason
	if refusal == streamcap.ByServer {
		err = serverStreamCapError("terminals", h.streamCaps.ServerMax())
		reason = streamcap.ServerReason
	}
	slog.WarnContext(r.Context(), "terminal refused", "err", err)
	failed(err)
	conn, uerr := upgrader.Upgrade(w, r, nil) // a wrong Origin is answered 403 here, as for any terminal
	if uerr != nil {
		return release, false
	}
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(streamcap.CloseCode, reason), time.Now().Add(time.Second))
	_ = conn.Close()
	return release, false
}

// takeFollowedLog holds one of the account's followed-log places on this server (MAX_FOLLOWED_LOGS_PER_ACCOUNT), and one
// of the server's (MAX_STREAMS_PER_SERVER), before the stream starts and returns the release, which the handler defers.
// Past either cap nothing is read from the cluster: failed writes the read's failed row, the answer is the event
// streamcap.Event with streamcap.FollowedLogReason (the account's cap) or streamcap.ServerReason (the server's), which
// the screen reads as why, and ok is false.
func (h *Handler) takeFollowedLog(w http.ResponseWriter, r *http.Request, failed func(error)) (release func(), ok bool) {
	release, refusal := h.streamCaps.Try(streamAccount(r), streamcap.FollowedLog)
	if refusal == streamcap.Taken {
		return release, true
	}
	err := streamCapError("followed logs", "maxFollowedLogsPerAccount", h.streamCaps.Max(streamcap.FollowedLog))
	reason := streamcap.FollowedLogReason
	if refusal == streamcap.ByServer {
		err = serverStreamCapError("followed logs", h.streamCaps.ServerMax())
		reason = streamcap.ServerReason
	}
	slog.WarnContext(r.Context(), "followed log refused", "err", err)
	failed(err)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "retry: %d\nevent: %s\ndata: %s\n\n", followedLogLimitRetryMs, streamcap.Event, reason)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return release, false
}
