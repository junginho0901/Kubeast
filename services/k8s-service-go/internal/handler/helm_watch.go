package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
)

// helmWatchUpgrader is local to this file rather than reusing the
// multiplexer's package-level upgrader — keeps WebSocket configuration
// concerns scoped to their handler.
var helmWatchUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// helmWatchTimeoutSeconds is the K8s watch's server-side timeout. The
// API server forces a re-list and rebroadcasts at this interval; we
// reconnect transparently. 5 minutes matches what the multiplexer uses
// for native resources (see ws/multiplexer.go).
const helmWatchTimeoutSeconds int64 = 300

// helmWatchPongWait bounds how long we wait for a client pong before
// declaring the connection dead. Helm release Secrets see very low
// event rates so we cannot rely on traffic to detect a half-open TCP
// connection — keepalive pings are required.
const helmWatchPongWait = 60 * time.Second

// helmWatchPingInterval must be smaller than pongWait. 30s matches
// browser timer coalescing well — most browsers will not throttle a
// background tab harder than this.
const helmWatchPingInterval = 30 * time.Second

// WatchHelmReleases handles GET /api/v1/helm/releases/watch and pushes
// real-time release events back to the client over a WebSocket. Replaces
// the prior 30s polling on the Helm Releases page.
//
// Mechanism:
//  1. JWT auth + resource.helm.read permission check (same as REST).
//  2. K8s Secret watch with fieldSelector "type=helm.sh/release.v1"
//     scoped to the requested namespace ("" = cluster-wide).
//  3. Each Secret event is decoded via helm.DecodeReleaseSecret() into
//     a ReleaseSummary (same shape as GET /helm/releases) and forwarded.
//
// Path: GET /api/v1/helm/releases/watch?namespace=&cluster=default
//
//   - namespace empty → cluster-wide watch
//   - cluster query is reserved for the multi-cluster transition (see
//     prereq doc); ignored today, the request hits Default() either way.
func (h *Handler) WatchHelmReleases(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.read"); err != nil {
		// requirePermission returns "unauthorized" / "forbidden" strings
		// that handleError maps to status codes — same as REST handlers.
		h.handleError(w, err)
		return
	}

	conn, err := helmWatchUpgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade has already written the HTTP response on error, so
		// we only need to log.
		slog.Error("helm watch ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	namespace := r.URL.Query().Get("namespace")

	// Pong handler resets the read deadline; combined with the periodic
	// ping below this kills half-open connections within ~30-60s.
	conn.SetReadDeadline(time.Now().Add(helmWatchPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(helmWatchPongWait))
		return nil
	})

	// Reader loop: we don't expect client messages, but the read loop
	// must run to surface client-initiated close to ctx cancellation.
	go func() {
		defer cancel()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Ping loop — must serialize WebSocket writes with the event sender,
	// so we use a dedicated channel instead of writing from this goroutine.
	pingCh := make(chan struct{}, 1)
	go func() {
		ticker := time.NewTicker(helmWatchPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				select {
				case pingCh <- struct{}{}:
				default: // sender busy; drop this tick
				}
			}
		}
	}()

	if err := h.runHelmWatch(ctx, conn, namespace, pingCh); err != nil {
		slog.Warn("helm watch ended with error", "err", err, "namespace", namespace)
	}
}

// runHelmWatch is the long-lived loop that streams Secret events into
// the WebSocket. Returns when the context is cancelled (client disconnect)
// or when a non-recoverable error happens.
func (h *Handler) runHelmWatch(ctx context.Context, conn *websocket.Conn, namespace string, pingCh <-chan struct{}) error {
	for {
		if ctx.Err() != nil {
			return nil
		}

		watcher, err := h.startSecretWatch(ctx, namespace)
		if err != nil {
			// startSecretWatch already wrote an ERROR frame to the client.
			// Back off briefly and retry — kubeconfig hot-reload or a
			// transient API server hiccup should not kill the stream.
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
				continue
			}
		}

		if err := h.consumeWatch(ctx, conn, watcher, pingCh); err != nil {
			watcher.Stop()
			return err
		}
		watcher.Stop()

		// The K8s server-side TimeoutSeconds reached. Re-list and rewatch.
		if ctx.Err() != nil {
			return nil
		}
	}
}

// startSecretWatch opens the Secret watch with the helm release fieldSelector.
// Server-side filtering keeps the event volume low — the API server sends
// only "type=helm.sh/release.v1" Secrets, never random other Secrets.
func (h *Handler) startSecretWatch(ctx context.Context, namespace string) (watch.Interface, error) {
	timeout := helmWatchTimeoutSeconds
	opts := metav1.ListOptions{
		FieldSelector:  "type=" + helm.SecretType,
		Watch:          true,
		TimeoutSeconds: &timeout,
	}

	cs := h.svc.Clientset()
	if cs == nil {
		return nil, errKubeconfigNotLoaded
	}

	// "" namespace = cluster-wide. The CoreV1().Secrets("") factory
	// already does the right thing — it issues against /api/v1/secrets
	// rather than /api/v1/namespaces//secrets.
	return cs.CoreV1().Secrets(namespace).Watch(ctx, opts)
}

// consumeWatch drains a single watcher until it ends or ctx is done.
// Each ADDED/MODIFIED/DELETED Secret event is decoded into a
// ReleaseSummary and pushed to the client; decode failures are logged
// but do not kill the stream.
func (h *Handler) consumeWatch(ctx context.Context, conn *websocket.Conn, watcher watch.Interface, pingCh <-chan struct{}) error {
	results := watcher.ResultChan()
	for {
		select {
		case <-ctx.Done():
			return nil

		case <-pingCh:
			deadline := time.Now().Add(10 * time.Second)
			if err := conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				return err
			}

		case event, ok := <-results:
			if !ok {
				// Watcher closed — caller will reopen.
				return nil
			}

			secret, ok := event.Object.(*corev1.Secret)
			if !ok {
				// Bookmark / Status / Error events come through here —
				// they have no release payload, so skip silently.
				continue
			}

			summary, err := helm.DecodeReleaseSecret(secret)
			if err != nil {
				slog.Warn("decode helm release failed",
					"secret", secret.Namespace+"/"+secret.Name,
					"err", err,
				)
				continue
			}

			msg := helmWatchMessage{
				Type:   string(event.Type),
				Object: summary,
			}
			if err := writeHelmWatchJSON(conn, msg); err != nil {
				return err
			}
		}
	}
}

// helmWatchMessage is the wire format sent to the WebSocket client. The
// shape mirrors useKubeWatchList's expectations: { type, object }.
type helmWatchMessage struct {
	Type   string             `json:"type"`
	Object *helm.ReleaseSummary `json:"object"`
}

func writeHelmWatchJSON(conn *websocket.Conn, msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		// Unrecoverable — bail.
		return err
	}
	// 10s write deadline matches the multiplexer's behavior — any longer
	// and we'd rather drop the connection than block the watcher loop.
	if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

// errKubeconfigNotLoaded is returned when the kubeconfig has not finished
// loading (or hot-reload dropped it). Sentinel rather than a fmt.Errorf
// so callers can distinguish "retry" from "give up".
var errKubeconfigNotLoaded = &kubeconfigError{}

type kubeconfigError struct{}

func (*kubeconfigError) Error() string { return "kubeconfig not loaded" }
