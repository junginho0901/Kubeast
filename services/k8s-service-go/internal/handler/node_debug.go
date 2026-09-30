package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"

	"github.com/junginho0901/kubeast/services/pkg/audit"
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

	// Audit at connection time (per §11 Q2). We do not record session
	// duration or individual commands — that's a v2 decision.
	h.recordAuditWithPayload(r, "k8s.node.shell", "node", nodeName, namespace, nil,
		nil, audit.MustJSON(map[string]interface{}{"image": image}))

	conn, err := debugUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("debug shell ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	if imageErr != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("\r\n"+imageErr.Error()+"\r\n"))
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Clients for the cluster selected on the request (not the default one).
	clientset, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\ncluster client: %v\r\n", err)))
		return
	}
	// The attach runs as the signed-in user, like the pod calls above: the
	// executor builds its transport from this config, identity included.
	restConfig, err := h.svc.UserRESTConfigFor(ctx)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\ncluster config: %v\r\n", err)))
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
					Name:    "debugger",
					Image:   image,
					Command: []string{"/bin/sh"},
					Stdin:   true,
					TTY:     true,
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
		_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("\r\nfailed to prepare namespace %s: %v\r\n", namespace, err)))
		return
	}
	_, err = clientset.CoreV1().Pods(namespace).Create(ctx, debugPod, metav1.CreateOptions{})
	if err != nil {
		msg := fmt.Sprintf("failed to create debug pod: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}

	defer func() {
		grace := int64(0)
		bg := metav1.DeletePropagationBackground
		_ = clientset.CoreV1().Pods(namespace).Delete(context.Background(), podName, metav1.DeleteOptions{
			GracePeriodSeconds: &grace,
			PropagationPolicy:  &bg,
		})
		slog.Info("debug shell pod deleted", "pod", podName)
	}()

	// Wait for pod to be running
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

	slog.Info("debug shell attached", "pod", podName, "node", nodeName)
	if err := streamShell(ctx, conn, restConfig, attachURL(clientset, namespace, podName, "debugger")); err != nil {
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
