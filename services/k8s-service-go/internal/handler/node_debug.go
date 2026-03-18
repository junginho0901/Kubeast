package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

var debugUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// NodeDebugShellWS handles WebSocket /api/v1/nodes/{name}/debug-shell/ws.
// Creates a temporary debug pod on the target node and streams shell I/O.
func (h *Handler) NodeDebugShellWS(w http.ResponseWriter, r *http.Request) {
	// Admin only
	if err := h.requireAdmin(r); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	nodeName := chi.URLParam(r, "name")
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		namespace = "default"
	}
	image := r.URL.Query().Get("image")
	if image == "" {
		image = "docker.io/library/busybox:latest"
	}

	conn, err := debugUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("debug shell ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	slog.Info("debug shell ws connected", "node", nodeName, "namespace", namespace, "image", image)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	clientset := h.svc.Clientset()
	restConfig := h.svc.RestConfig()

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
			NodeName:      nodeName,
			HostPID:       true,
			HostIPC:       true,
			HostNetwork:   true,
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{
				{
					Name:    "debugger",
					Image:   image,
					Command: []string{"/bin/sh"},
					Stdin:   true,
					TTY:     true,
					SecurityContext: &corev1.SecurityContext{
						Privileged: boolPtr(true),
					},
					VolumeMounts: []corev1.VolumeMount{
						{
							Name:      "host-root",
							MountPath: "/host",
						},
					},
				},
			},
			Volumes: []corev1.Volume{
				{
					Name: "host-root",
					VolumeSource: corev1.VolumeSource{
						HostPath: &corev1.HostPathVolumeSource{
							Path: "/",
						},
					},
				},
			},
			Tolerations: []corev1.Toleration{
				{
					Operator: corev1.TolerationOpExists,
				},
			},
		},
	}

	_, err = clientset.CoreV1().Pods(namespace).Create(ctx, debugPod, metav1.CreateOptions{})
	if err != nil {
		msg := fmt.Sprintf("failed to create debug pod: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}

	// Cleanup: always delete the debug pod when done
	defer func() {
		grace := int64(0)
		bg := metav1.DeletePropagationBackground
		_ = clientset.CoreV1().Pods(namespace).Delete(context.Background(), podName, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
			PropagationPolicy:  &bg,
		})
		slog.Info("debug shell pod deleted", "pod", podName)
	}()

	// Wait for pod to be running (up to 90s)
	conn.WriteMessage(websocket.TextMessage, []byte("Waiting for debug pod to start...\r\n"))
	timeout := time.After(90 * time.Second)
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	podRunning := false
	for !podRunning {
		select {
		case <-ctx.Done():
			return
		case <-timeout:
			conn.WriteMessage(websocket.TextMessage, []byte("Timeout waiting for debug pod to start.\r\n"))
			return
		case <-ticker.C:
			pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
			if err != nil {
				continue
			}
			if pod.Status.Phase == corev1.PodRunning {
				podRunning = true
			} else if pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
				conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("Debug pod exited with phase: %s\r\n", pod.Status.Phase)))
				return
			}
		}
	}

	conn.WriteMessage(websocket.TextMessage, []byte("Debug pod running. Attaching...\r\n"))

	// Attach to the pod
	req := clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(podName).
		Namespace(namespace).
		SubResource("attach").
		VersionedParams(&corev1.PodAttachOptions{
			Container: "debugger",
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(restConfig, "POST", req.URL())
	if err != nil {
		msg := fmt.Sprintf("failed to create executor: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}

	// Bridge WebSocket <-> K8s SPDY stream
	wsStream := &wsStreamAdapter{conn: conn, ctx: ctx, cancel: cancel}

	slog.Info("debug shell attaching to pod", "pod", podName, "node", nodeName)
	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:  wsStream,
		Stdout: wsStream,
		Stderr: wsStream,
		Tty:    true,
	})
	if err != nil {
		errMsg := err.Error()
		slog.Error("debug shell stream ended", "err", err, "pod", podName, "node", nodeName)
		if !strings.Contains(errMsg, "closed") && !strings.Contains(errMsg, "websocket") {
			conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nStream error: %v\r\n", err)))
		}
	} else {
		slog.Info("debug shell stream ended normally", "pod", podName, "node", nodeName)
	}
}

// wsStreamAdapter bridges gorilla/websocket <-> io.Reader/io.Writer for remotecommand.
type wsStreamAdapter struct {
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	buf    []byte
}

// Read implements io.Reader - reads from WebSocket (client stdin).
func (a *wsStreamAdapter) Read(p []byte) (int, error) {
	for {
		if len(a.buf) > 0 {
			n := copy(p, a.buf)
			a.buf = a.buf[n:]
			return n, nil
		}

		_, msg, err := a.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		a.buf = msg
	}
}

// Write implements io.Writer - writes to WebSocket (server stdout/stderr).
// Prepends channel byte (1=stdout) so the frontend can parse correctly.
func (a *wsStreamAdapter) Write(p []byte) (int, error) {
	msg := make([]byte, len(p)+1)
	msg[0] = 1 // stdout channel
	copy(msg[1:], p)
	err := a.conn.WriteMessage(websocket.BinaryMessage, msg)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func boolPtr(b bool) *bool {
	return &b
}
