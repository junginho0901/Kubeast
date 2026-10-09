package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// How long the debug pod has to start, and how often it is checked.
var (
	nodeShellStartSec     = 90
	nodeShellPollInterval = time.Second
)

var debugUpgrader = websocket.Upgrader{
	CheckOrigin:       ws.CheckOrigin,
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
}

// NodeDebugShellWS handles WebSocket /api/v1/nodes/{name}/debug-shell/ws.
func (h *Handler) NodeDebugShellWS(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.node.shell"); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	if !h.cfg.NodeShellEnabled {
		http.Error(w, "node shell is disabled (NODE_SHELL_ENABLED)", http.StatusForbidden)
		return
	}

	nodeName := chi.URLParam(r, "name")
	// The debug pod always runs in the dedicated privileged namespace with an
	// allow-listed image; the client's namespace/image choices are not trusted.
	namespace := h.cfg.NodeShellNamespace
	image, imageErr := nodeShellImage(h.cfg.NodeShellImages, r.URL.Query().Get("image"))

	// One audit row per attempt, written once the outcome is known: success
	// when the shell is handed over (before the attach), failure with the
	// reason otherwise. A store that cannot take a row refuses up front. With
	// session recording on, the terminal output is recorded too (recording_id).
	if rerr := h.auditReady(r); rerr != nil {
		h.refuseUnaudited(w, r, rerr)
		return
	}
	payload := map[string]interface{}{"image": image}
	var rec *recording.Session
	if imageErr == nil { // a rejected image never opens a shell: nothing to record
		var ok bool
		if rec, ok = h.startRecording(w, r, "node-shell", namespace, nodeName, "", "k8s.node.shell", "node", payload); !ok {
			return
		}
	}
	fail := func(err error) {
		h.recorder.Abort(rec)
		_ = h.recordAuditWithPayload(r, "k8s.node.shell", "node", nodeName, namespace, err, nil, audit.MustJSON(payload))
	}

	conn, err := debugUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("debug shell ws upgrade failed", "err", err)
		fail(fmt.Errorf("websocket upgrade: %w", err))
		return
	}
	defer conn.Close()
	conn.SetReadLimit(terminalFrameMaxBytes)

	if imageErr != nil {
		fail(imageErr)
		writeShellStatus(conn, shellStatus{Status: shellImageRejected, Message: imageErr.Error()})
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// The socket's reader from here on: closing the window while the pod is
	// still starting ends the wait (and deletes the pod) instead of the timeout.
	in := readFrames(ctx, conn)

	// Clients for the cluster selected on the request (not the default one).
	clientset, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		fail(fmt.Errorf("cluster client: %w", err))
		writeShellStatus(conn, shellStatus{Status: shellFailed, Message: fmt.Sprintf("cluster client: %v", err)})
		return
	}
	// The attach runs as the signed-in user, like the pod calls above: the
	// executor builds its transport from this config, identity included.
	restConfig, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		fail(fmt.Errorf("cluster config: %w", err))
		writeShellStatus(conn, shellStatus{Status: shellFailed, Message: fmt.Sprintf("cluster config: %v", err)})
		return
	}

	// Create debug pod
	podName := fmt.Sprintf("node-debugger-%s-%s", nodeName, rand.String(5))
	debugPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: namespace,
			Labels: map[string]string{
				"app":     "node-debugger",
				"node":    nodeName,
				"managed": "k8s-service",
			},
		},
		Spec: corev1.PodSpec{
			NodeName:                     nodeName,
			HostPID:                      true,
			HostIPC:                      true,
			HostNetwork:                  true,
			RestartPolicy:                corev1.RestartPolicyNever,
			ActiveDeadlineSeconds:        int64p(int64(h.cfg.NodeShellTimeoutSec)),
			AutomountServiceAccountToken: boolPtr(false),
			Containers: []corev1.Container{
				{
					Name:  "debugger",
					Image: image,
					// A node that already has the image opens the shell without
					// reaching the registry (a `:latest` image would default to Always).
					ImagePullPolicy: corev1.PullIfNotPresent,
					Command:         []string{"/bin/sh"},
					Stdin:           true,
					TTY:             true,
					SecurityContext: &corev1.SecurityContext{
						Privileged: boolPtr(true),
					},
					VolumeMounts: []corev1.VolumeMount{
						{Name: "host-root", MountPath: "/host"},
					},
				},
			},
			Volumes: []corev1.Volume{
				{
					Name: "host-root",
					VolumeSource: corev1.VolumeSource{
						HostPath: &corev1.HostPathVolumeSource{Path: "/"},
					},
				},
			},
			Tolerations: []corev1.Toleration{
				{Operator: corev1.TolerationOpExists},
			},
		},
	}

	if err := ensureNodeShellNamespace(ctx, clientset, namespace); err != nil {
		err = fmt.Errorf("prepare namespace %s: %w", namespace, err)
		fail(err)
		writeShellStatus(conn, shellStatus{Status: shellFailed, Message: err.Error()})
		return
	}
	_, err = clientset.CoreV1().Pods(namespace).Create(ctx, debugPod, metav1.CreateOptions{})
	if err != nil {
		err = fmt.Errorf("create debug pod: %w", err)
		slog.Error("debug shell", "err", err)
		fail(err)
		writeShellStatus(conn, shellStatus{Status: shellFailed, Message: err.Error()})
		return
	}

	// The cleanup outlives the request (ctx is cancelled by then) but still
	// acts as the user who created the pod, like the drain goroutine.
	cleanupCtx := context.Background()
	if id, ok := cluster.FromContext(ctx); ok {
		cleanupCtx = cluster.WithID(cleanupCtx, id)
	}
	if p, ok := auth.FromContext(ctx); ok {
		cleanupCtx = auth.WithPayload(cleanupCtx, p)
	}
	defer func() {
		grace := int64(0)
		bg := metav1.DeletePropagationBackground
		_ = clientset.CoreV1().Pods(namespace).Delete(cleanupCtx, podName, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
			PropagationPolicy:  &bg,
		})
		slog.Info("debug shell pod deleted", "pod", podName)
	}()

	// Wait for the pod to run, telling the terminal why it is not yet
	// (ContainerCreating, ImagePullBackOff, …) each time the reason changes.
	writeShellStatus(conn, shellStatus{Status: shellWaiting})
	timeout := time.After(time.Duration(nodeShellStartSec) * time.Second)
	ticker := time.NewTicker(nodeShellPollInterval)
	defer ticker.Stop()

	var lastReason, lastMessage string
	for running := false; !running; {
		select {
		case <-ctx.Done():
			fail(ctx.Err())
			return
		case _, open := <-in:
			if !open { // the window closed before the shell opened
				fail(errors.New("closed before the shell opened"))
				return
			}
		case <-timeout:
			err := fmt.Errorf("debug pod did not start within %d s", nodeShellStartSec)
			if lastReason != "" {
				err = fmt.Errorf("%w: %s %s", err, lastReason, lastMessage)
			}
			fail(err)
			writeShellStatus(conn, shellStatus{Status: shellTimeout, Reason: lastReason, Message: lastMessage, Seconds: nodeShellStartSec})
			return
		case <-ticker.C:
			pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
			if err != nil {
				continue
			}
			switch state, reason, message := podStartState(pod); state {
			case podStartRunning:
				running = true
			case podStartEnded:
				fail(fmt.Errorf("debug pod ended before the shell opened: %s %s", reason, message))
				writeShellStatus(conn, shellStatus{Status: shellExited, Reason: reason, Message: message})
				return
			default:
				if reason != lastReason || message != lastMessage {
					lastReason, lastMessage = reason, message
					if reason != "" {
						writeShellStatus(conn, shellStatus{Status: shellWaiting, Reason: reason, Message: message})
					}
				}
			}
		}
	}

	if werr := h.recordAuditWithPayload(r, "k8s.node.shell", "node", nodeName, namespace, nil,
		nil, audit.MustJSON(payload)); werr != nil {
		h.recorder.Abort(rec)
		slog.WarnContext(r.Context(), "audit: refusing unrecorded action", "method", r.Method, "path", r.URL.Path, "error", werr)
		writeShellStatus(conn, shellStatus{Status: shellAuditUnavailable})
		return
	}
	defer rec.Close()
	writeShellStatus(conn, shellStatus{Status: shellStarting})

	slog.Info("debug shell attached", "pod", podName, "node", nodeName)
	if err := streamShell(ctx, conn, in, restConfig, attachURL(clientset, namespace, podName, "debugger"), rec); err != nil {
		msg := fmt.Sprintf("failed to connect to K8s API: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}
	slog.Info("debug shell ended", "pod", podName, "node", nodeName)
}

func boolPtr(b bool) *bool {
	return &b
}
