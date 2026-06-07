package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
)

// helmWatchTimeoutSeconds is the K8s watch's server-side timeout. The
// API server forces a re-list and rebroadcasts at this interval; we
// reconnect transparently. 5 minutes matches what the multiplexer uses
// for native resources (see ws/multiplexer.go).
const helmWatchTimeoutSeconds int64 = 300

// helmWatchKeepaliveInterval — SSE comment line (": keepalive\n\n") 주기.
// proxy / LB idle timeout 방어용. 이전 WebSocket 의 30s ping interval 과 동일.
const helmWatchKeepaliveInterval = 30 * time.Second

// WatchHelmReleases handles GET /api/v1/helm/releases/stream and pushes
// real-time release events back to the client over Server-Sent Events.
// Replaces the prior WebSocket implementation.
//
// Mechanism:
//  1. JWT auth + resource.helm.read permission check (same as REST).
//  2. K8s Secret watch with fieldSelector "type=helm.sh/release.v1"
//     scoped to the requested namespace ("" = cluster-wide).
//  3. Each Secret event is decoded via helm.DecodeReleaseSecret() into
//     a ReleaseSummary and forwarded as SSE 'data:' frames.
//
// Why SSE instead of WebSocket:
//   - This stream is single-direction (server → client). Client never sends
//     a request after the initial GET.
//   - Browser EventSource gives free automatic reconnect on idle timeout
//     or transient network failure.
//   - Replaces the WS-side ping/pong dance with a single SSE comment line.
//
// Path: GET /api/v1/helm/releases/stream?namespace=&cluster=default
//
//   - namespace empty → cluster-wide watch
//   - cluster query selects the target cluster (ClientsetFor(ctx), via
//     ClusterMiddleware); absent → default cluster.
func (h *Handler) WatchHelmReleases(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.helm.read"); err != nil {
		h.handleError(w, err)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// nginx ingress 의 proxy_buffering 을 응답 단위로 끔 — SSE 는 즉시 flush 필수.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	namespace := r.URL.Query().Get("namespace")

	if err := h.runHelmWatchSSE(r.Context(), w, flusher, namespace); err != nil {
		slog.Warn("helm watch sse ended with error", "err", err, "namespace", namespace)
	}
}

// runHelmWatchSSE is the long-lived loop that streams Secret events as SSE
// frames. Returns when the request context is cancelled (client disconnect)
// or when a non-recoverable error happens. K8s watcher 의 server-side
// TimeoutSeconds 가 차면 자동으로 새 watcher 를 열어 transparent reconnect.
func (h *Handler) runHelmWatchSSE(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, namespace string) error {
	keepalive := time.NewTicker(helmWatchKeepaliveInterval)
	defer keepalive.Stop()

	for {
		if ctx.Err() != nil {
			return nil
		}

		watcher, err := h.startSecretWatch(ctx, namespace)
		if err != nil {
			// transient kubeconfig hot-reload / API server hiccup — back off + retry
			if writeErr := writeSSEEvent(w, flusher, "error", err.Error()); writeErr != nil {
				return writeErr
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
				continue
			}
		}

		if err := h.consumeWatchSSE(ctx, w, flusher, watcher, keepalive); err != nil {
			watcher.Stop()
			return err
		}
		watcher.Stop()

		if ctx.Err() != nil {
			return nil
		}
		// K8s 의 TimeoutSeconds 가 차서 watcher 가 닫혔다. for 루프가 새 watcher 시작.
	}
}

// startSecretWatch opens the Secret watch with the helm release fieldSelector.
func (h *Handler) startSecretWatch(ctx context.Context, namespace string) (watch.Interface, error) {
	timeout := helmWatchTimeoutSeconds
	opts := metav1.ListOptions{
		FieldSelector:  "type=" + helm.SecretType,
		Watch:          true,
		TimeoutSeconds: &timeout,
	}

	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return nil, err
	}
	if cs == nil {
		return nil, errKubeconfigNotLoaded
	}

	return cs.CoreV1().Secrets(namespace).Watch(ctx, opts)
}

// consumeWatchSSE drains a single watcher until it ends or ctx is done.
// Each ADDED/MODIFIED/DELETED Secret event is decoded into a ReleaseSummary
// and pushed as an SSE 'data:' frame. Keepalive comments are interleaved.
func (h *Handler) consumeWatchSSE(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, watcher watch.Interface, keepalive *time.Ticker) error {
	results := watcher.ResultChan()
	for {
		select {
		case <-ctx.Done():
			return nil

		case <-keepalive.C:
			// SSE comment 라인 — 브라우저 EventSource 가 무시. proxy/LB idle
			// timeout 만 막아준다. 이전 WebSocket 의 ping/pong 대체.
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return err
			}
			flusher.Flush()

		case event, ok := <-results:
			if !ok {
				return nil
			}

			secret, ok := event.Object.(*corev1.Secret)
			if !ok {
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
			payload, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
				return err
			}
			flusher.Flush()
		}
	}
}

// writeSSEEvent writes a named SSE event with a single-line data payload.
// Used for error frames during watcher startup failures.
func writeSSEEvent(w http.ResponseWriter, flusher http.Flusher, name, data string) error {
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

// helmWatchMessage is the wire format sent to the SSE client. The shape
// mirrors useKubeWatchList's expectations: { type, object }.
type helmWatchMessage struct {
	Type   string               `json:"type"`
	Object *helm.ReleaseSummary `json:"object"`
}

// errKubeconfigNotLoaded is returned when the kubeconfig has not finished
// loading (or hot-reload dropped it).
var errKubeconfigNotLoaded = &kubeconfigError{}

type kubeconfigError struct{}

func (*kubeconfigError) Error() string { return "kubeconfig not loaded" }
