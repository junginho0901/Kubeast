package handler

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/transport"
)

var debugUpgrader = websocket.Upgrader{
	CheckOrigin:       func(r *http.Request) bool { return true },
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
}

// NodeDebugShellWS handles WebSocket /api/v1/nodes/{name}/debug-shell/ws.
func (h *Handler) NodeDebugShellWS(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.shell"); err != nil {
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

	// Build K8s API WebSocket URL
	host := restConfig.Host
	wsBase := strings.Replace(strings.Replace(host, "https://", "wss://", 1), "http://", "ws://", 1)
	attachPath := fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/attach", namespace, podName)
	qp := url.Values{
		"container": {"debugger"},
		"stdin":     {"1"},
		"stdout":    {"1"},
		"stderr":    {"1"},
		"tty":       {"1"},
	}
	k8sURL := fmt.Sprintf("%s%s?%s", wsBase, attachPath, qp.Encode())

	// TLS config from client-go transport
	transportConfig, err := restConfig.TransportConfig()
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("transport config error: %v\r\n", err)))
		return
	}
	tlsConfig, err := transport.TLSConfigFor(transportConfig)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("TLS config error: %v\r\n", err)))
		return
	}
	if tlsConfig == nil {
		tlsConfig = &tls.Config{} //nolint:gosec
	}
	if tlsConfig.ServerName == "" && !tlsConfig.InsecureSkipVerify {
		if u, err := url.Parse(restConfig.Host); err == nil {
			tlsConfig.ServerName = u.Hostname()
		}
	}

	// Auth headers
	k8sHeaders := http.Header{}
	if restConfig.BearerToken != "" {
		k8sHeaders.Set("Authorization", "Bearer "+restConfig.BearerToken)
	} else if restConfig.BearerTokenFile != "" {
		if tokenBytes, err := os.ReadFile(restConfig.BearerTokenFile); err == nil {
			k8sHeaders.Set("Authorization", "Bearer "+strings.TrimSpace(string(tokenBytes)))
		}
	}

	// Dial K8s API with TCP_NODELAY
	dialer := websocket.Dialer{
		TLSClientConfig:  tlsConfig,
		HandshakeTimeout: 15 * time.Second,
		Subprotocols:     []string{"v4.channel.k8s.io", "v3.channel.k8s.io", "v2.channel.k8s.io", "channel.k8s.io"},
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
		NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			d := net.Dialer{}
			c, err := d.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.SetNoDelay(true)
			}
			return c, nil
		},
	}

	k8sWS, _, err := dialer.DialContext(ctx, k8sURL, k8sHeaders)
	if err != nil {
		msg := fmt.Sprintf("failed to connect to K8s API: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}
	defer k8sWS.Close()

	slog.Info("debug shell attached", "pod", podName, "node", nodeName)

	// Trigger initial prompt
	_ = k8sWS.WriteMessage(websocket.BinaryMessage, []byte{0, '\r'})

	var wg sync.WaitGroup
	wg.Add(2)

	// K8s -> Browser
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			msgType, data, err := k8sWS.ReadMessage()
			if err != nil {
				if !isExpectedClose(err) {
					slog.Debug("k8s ws read error", "err", err)
				}
				return
			}
			if err := conn.WriteMessage(msgType, data); err != nil {
				return
			}
		}
	}()

	// Browser -> K8s
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				_ = k8sWS.WriteMessage(websocket.BinaryMessage, []byte{0, 'e', 'x', 'i', 't', '\r'})
				return
			}
			if len(data) > 0 {
				msg := make([]byte, len(data)+1)
				msg[0] = 0
				copy(msg[1:], data)
				if err := k8sWS.WriteMessage(websocket.BinaryMessage, msg); err != nil {
					return
				}
			}
		}
	}()

	wg.Wait()
	slog.Info("debug shell ended", "pod", podName, "node", nodeName)
}

func isExpectedClose(err error) bool {
	if err == nil {
		return false
	}
	if err == io.EOF {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "closed") || strings.Contains(s, "websocket") || strings.Contains(s, "EOF") || strings.Contains(s, "going away")
}

func boolPtr(b bool) *bool {
	return &b
}
