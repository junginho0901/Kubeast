package handler

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
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
)

var debugUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// NodeDebugShellWS handles WebSocket /api/v1/nodes/{name}/debug-shell/ws.
// Creates a temporary debug pod on the target node and streams shell I/O
// using a K8s WebSocket attach (v4.channel.k8s.io) — same approach as Python.
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

	// Build K8s API WebSocket URL (same approach as Python: aiohttp + v4.channel.k8s.io)
	host := restConfig.Host
	wsBase := strings.Replace(strings.Replace(host, "https://", "wss://", 1), "http://", "ws://", 1)
	attachPath := fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/attach", namespace, podName)
	params := url.Values{
		"container": {"debugger"},
		"stdin":     {"1"},
		"stdout":    {"1"},
		"stderr":    {"1"},
		"tty":       {"1"},
	}
	k8sURL := fmt.Sprintf("%s%s?%s", wsBase, attachPath, params.Encode())

	// Build TLS config from REST config (load CA cert to verify K8s API server)
	tlsConfig := &tls.Config{
		InsecureSkipVerify: restConfig.TLSClientConfig.Insecure, //nolint:gosec
	}
	// Load CA certificate
	if len(restConfig.TLSClientConfig.CAData) > 0 {
		caCertPool := x509.NewCertPool()
		caCertPool.AppendCertsFromPEM(restConfig.TLSClientConfig.CAData)
		tlsConfig.RootCAs = caCertPool
	} else if restConfig.TLSClientConfig.CAFile != "" {
		caCert, err := os.ReadFile(restConfig.TLSClientConfig.CAFile)
		if err == nil {
			caCertPool := x509.NewCertPool()
			caCertPool.AppendCertsFromPEM(caCert)
			tlsConfig.RootCAs = caCertPool
		}
	}
	// Load client certificate
	if restConfig.TLSClientConfig.CertData != nil && restConfig.TLSClientConfig.KeyData != nil {
		cert, err := tls.X509KeyPair(restConfig.TLSClientConfig.CertData, restConfig.TLSClientConfig.KeyData)
		if err == nil {
			tlsConfig.Certificates = []tls.Certificate{cert}
		}
	} else if restConfig.TLSClientConfig.CertFile != "" && restConfig.TLSClientConfig.KeyFile != "" {
		cert, err := tls.LoadX509KeyPair(restConfig.TLSClientConfig.CertFile, restConfig.TLSClientConfig.KeyFile)
		if err == nil {
			tlsConfig.Certificates = []tls.Certificate{cert}
		}
	}

	// Build auth headers
	k8sHeaders := http.Header{}
	if restConfig.BearerToken != "" {
		k8sHeaders.Set("Authorization", "Bearer "+restConfig.BearerToken)
	} else if restConfig.BearerTokenFile != "" {
		if tokenBytes, err := os.ReadFile(restConfig.BearerTokenFile); err == nil {
			k8sHeaders.Set("Authorization", "Bearer "+strings.TrimSpace(string(tokenBytes)))
		}
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  tlsConfig,
		HandshakeTimeout: 10 * time.Second,
		Subprotocols:     []string{"v4.channel.k8s.io", "v3.channel.k8s.io", "v2.channel.k8s.io", "channel.k8s.io"},
	}

	k8sWS, _, err := dialer.DialContext(ctx, k8sURL, k8sHeaders)
	if err != nil {
		msg := fmt.Sprintf("failed to connect to K8s API: %v", err)
		slog.Error(msg)
		conn.WriteMessage(websocket.TextMessage, []byte(msg+"\r\n"))
		return
	}
	defer k8sWS.Close()

	slog.Info("debug shell connected to K8s API via WebSocket", "pod", podName, "node", nodeName)

	// Send initial newline to trigger prompt (channel 0 = stdin)
	_ = k8sWS.WriteMessage(websocket.BinaryMessage, []byte{0, '\r'})

	// Bidirectional relay using two goroutines (same as Python's asyncio.gather)
	var wg sync.WaitGroup
	wg.Add(2)

	// K8s -> Browser: relay binary frames directly (already have channel bytes)
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
			if msgType == websocket.BinaryMessage {
				if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
					return
				}
			} else if msgType == websocket.TextMessage {
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			}
		}
	}()

	// Browser -> K8s: prepend stdin channel byte (0)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				// Client disconnected — send exit to K8s
				_ = k8sWS.WriteMessage(websocket.BinaryMessage, []byte{0, 'e', 'x', 'i', 't', '\r'})
				return
			}
			var payload []byte
			if msgType == websocket.BinaryMessage {
				payload = data
			} else if msgType == websocket.TextMessage {
				payload = data
			} else {
				continue
			}
			if len(payload) > 0 {
				// Prepend channel 0 (stdin) — same as Python's b"\x00" + payload
				msg := make([]byte, len(payload)+1)
				msg[0] = 0 // stdin channel
				copy(msg[1:], payload)
				if err := k8sWS.WriteMessage(websocket.BinaryMessage, msg); err != nil {
					return
				}
			}
		}
	}()

	wg.Wait()
	slog.Info("debug shell stream ended", "pod", podName, "node", nodeName)
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
