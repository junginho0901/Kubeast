package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/redact"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// terminalFrameMaxBytes bounds a client → server frame on the exec and node
// shell sockets: terminal input is keystrokes, pastes and resize messages
// (second review M30).
const terminalFrameMaxBytes = 32 * 1024

var execUpgrader = websocket.Upgrader{
	CheckOrigin:       ws.CheckOrigin,
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
}

// execRowRedactOpts: a stored row cannot be masked later, so it does not follow REDACTION_ENABLED, as an AI exec's row does not.
var execRowRedactOpts = redact.Options{Enabled: true, Disabled: map[string]bool{}}

// execError is an exec's error as its row and the log hold it: a container runtime names a command it could not start
// as it came (exec: "<command>": executable file not found), so it is masked as the row's command is.
func execError(err error) error {
	return errors.New(redact.Command([]string{err.Error()}, execRowRedactOpts)[0])
}

// PodExecWS handles WebSocket /api/v1/namespaces/{namespace}/pods/{name}/exec/ws.
// Write+Admin: opens an interactive shell into a running container.
func (h *Handler) PodExecWS(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.pod.exec"); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if h.refuseTerminalWhileLeaving(w) {
		return
	}

	namespace := chi.URLParam(r, "namespace")
	podName := chi.URLParam(r, "name")
	container := r.URL.Query().Get("container")
	command := r.URL.Query().Get("command")
	if command == "" {
		command = "/bin/sh"
	}

	// Audit at connection time (per §11 Q2); no session without the row.
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	// The row holds what was asked with its credentials masked; only the container gets the command as it came.
	payload := map[string]interface{}{"container": container, "command": redact.Command([]string{command}, execRowRedactOpts)[0]}
	rec, ok := h.startRecording(w, r, "exec", namespace, podName, container, "k8s.pod.exec", "pod", payload)
	if !ok {
		return
	}
	if werr := h.recordAuditWithPayload(r, "k8s.pod.exec", "pod", podName, namespace, nil,
		nil, audit.MustJSON(payload)); werr != nil {
		h.recorder.Abort(rec)
		h.refuseUnaudited(w, r, werr)
		return
	}
	defer rec.Close()

	conn, err := execUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("pod exec ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()
	conn.SetReadLimit(terminalFrameMaxBytes) // keystrokes and resizes; never a bulk upload

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	ctx, release := h.holdSession(ctx)
	defer release()
	ctx, leave := h.drain.HoldTerminal(ctx)
	defer leave()

	// The exec runs on the request's cluster as the signed-in user: the
	// executor builds its transport from this config, identity included.
	// The row above says the session was opened; one that never got a shell
	// says so in a second, failed row (a closed tab is not a failure).
	failed := func(err error) {
		_ = h.recordAuditWithPayload(r, "k8s.pod.exec", "pod", podName, namespace, execError(err), nil, audit.MustJSON(payload))
	}
	cfg, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		failed(fmt.Errorf("cluster config: %w", err))
		_ = conn.WriteMessage(websocket.TextMessage, []byte("cluster config: "+response.Public(err)+"\r\n"))
		return
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		failed(fmt.Errorf("cluster client: %w", err))
		_ = conn.WriteMessage(websocket.TextMessage, []byte("cluster client: "+response.Public(err)+"\r\n"))
		return
	}

	slog.Info("pod exec attached", "pod", podName, "namespace", namespace, "container", container)
	if err := streamShell(ctx, conn, readFrames(ctx, conn), cfg, execURL(cs, namespace, podName, container, command), rec, r.URL.Query().Get("lang")); err != nil {
		slog.Error("failed to connect to K8s API", "err", execError(err))
		if ctx.Err() == nil {
			failed(err)
		}
		_ = conn.WriteMessage(websocket.TextMessage, []byte("failed to connect to K8s API: "+response.Public(err)+"\r\n"))
		return
	}
	h.auditSessionEnd(ctx, r, "pod", podName, namespace, "exec")
	slog.Info("pod exec ended", "pod", podName, "namespace", namespace)
}
