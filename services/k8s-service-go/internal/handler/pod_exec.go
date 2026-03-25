package handler

import (
	"context"
	"crypto/tls"
	"fmt"
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
	"k8s.io/client-go/transport"
)

var execUpgrader = websocket.Upgrader{
	CheckOrigin:       func(r *http.Request) bool { return true },
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false,
}

// PodExecWS handles WebSocket /api/v1/namespaces/{namespace}/pods/{name}/exec/ws.
// Write+Admin: opens an interactive shell into a running container.
func (h *Handler) PodExecWS(w http.ResponseWriter, r *http.Request) {
	if err := h.requireAdmin(r); err != nil {
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

	conn, err := execUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("pod exec ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	restConfig := h.svc.RestConfig()

	// Build K8s API WebSocket URL for exec
	host := restConfig.Host
	wsBase := strings.Replace(strings.Replace(host, "https://", "wss://", 1), "http://", "ws://", 1)
	execPath := fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/exec", namespace, podName)
	qp := url.Values{
		"command": {command},
		"stdin":   {"1"},
		"stdout":  {"1"},
		"stderr":  {"1"},
		"tty":     {"1"},
	}
	if container != "" {
		qp.Set("container", container)
	}
	k8sURL := fmt.Sprintf("%s%s?%s", wsBase, execPath, qp.Encode())

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

	slog.Info("pod exec attached", "pod", podName, "namespace", namespace, "container", container)

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
					slog.Debug("pod exec k8s ws read error", "err", err)
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
	slog.Info("pod exec ended", "pod", podName, "namespace", namespace)
}
