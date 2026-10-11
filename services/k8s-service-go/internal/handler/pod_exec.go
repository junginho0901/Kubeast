package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"

	"github.com/junginho0901/kubeast/services/pkg/audit"
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

// PodExecWS handles WebSocket /api/v1/namespaces/{namespace}/pods/{name}/exec/ws.
// Write+Admin: opens an interactive shell into a running container.
func (h *Handler) PodExecWS(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.pod.exec"); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
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
	payload := map[string]interface{}{"container": container, "command": command}
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

	// The exec runs on the request's cluster as the signed-in user: the
	// executor builds its transport from this config, identity included.
	cfg, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("cluster config: %v\r\n", err)))
		return
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("cluster client: %v\r\n", err)))
		return
	}

	slog.Info("pod exec attached", "pod", podName, "namespace", namespace, "container", container)
	if err := streamShell(ctx, conn, readFrames(ctx, conn), cfg, execURL(cs, namespace, podName, container, command), rec, r.URL.Query().Get("lang")); err != nil {
		msg := fmt.Sprintf("failed to connect to K8s API: %v", err)
		slog.Error(msg)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}
	slog.Info("pod exec ended", "pod", podName, "namespace", namespace)
}
