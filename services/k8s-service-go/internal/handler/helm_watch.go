package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// helmWatchKeepaliveInterval — SSE comment line (": keepalive\n\n") 주기.
// proxy / LB idle timeout 방어용. 이전 WebSocket 의 30s ping interval 과 동일.
const helmWatchKeepaliveInterval = 30 * time.Second

// helmLimitRetry is the wait before a stream the server's limit of live watches refused asks again: half a minute to
// five, as a page the sockets refused asks again, so what was refused together does not come back together.
var helmLimitRetry = func() time.Duration { return 30*time.Second + rand.N(270*time.Second) }

// helmLimitFrame is what the page's watch problem notice reads of a socket's refusal for the server's limit.
var helmLimitFrame = func() string {
	b, _ := json.Marshal(map[string]string{"reason": "limit", "limit_scope": "server", "message": "max subscriptions reached for the server, cannot create new watch"})
	return string(b)
}()

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

	ctx, release := h.holdSession(r.Context())
	defer release()
	if err := h.runHelmWatchSSE(ctx, w, flusher, namespace); err != nil {
		slog.Warn("helm watch sse ended with error", "err", err, "namespace", namespace)
	}
	sayStreamEnded(ctx, w, flusher)
}

// runHelmWatchSSE is the long-lived loop that streams Secret events as SSE
// frames. Returns when the request context is cancelled (client disconnect)
// or when a non-recoverable error happens. K8s watcher 의 server-side
// TimeoutSeconds 가 차면 자동으로 새 watcher 를 열어 transparent reconnect.
func (h *Handler) runHelmWatchSSE(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, namespace string) error {
	keepalive := time.NewTicker(helmWatchKeepaliveInterval)
	defer keepalive.Stop()

	// The stream's watches count against the server's live watches while it is open (multicluster.wsMaxSubscriptions).
	release, told, err := h.holdHelmWatches(ctx, w, flusher, keepalive, helmWatchCount(ctx, namespace))
	if release == nil {
		return err
	}
	defer release()

	for {
		if ctx.Err() != nil {
			return nil
		}

		watcher, err := h.startSecretWatch(ctx, namespace)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// transient kubeconfig hot-reload / API server hiccup — back off + retry
			if writeErr := writeSSEEvent(w, flusher, "error", response.Public(err)); writeErr != nil {
				return writeErr
			}
			if !keepAliveFor(ctx, w, flusher, keepalive, 5*time.Second) {
				return nil
			}
			continue
		}
		// the page was told the limit kept it from following: it follows again
		if told {
			told = false
			if err := writeSSEEvent(w, flusher, "following", "{}"); err != nil {
				watcher.Stop()
				return err
			}
		}

		if err := h.consumeWatchSSE(ctx, w, flusher, watcher, keepalive); err != nil {
			watcher.Stop()
			return err
		}
		watcher.Stop()

		// K8s 의 TimeoutSeconds 가 차서 watcher 가 닫혔다. A moment's spread, as the sockets' watches go on, then a new one.
		if !keepAliveFor(ctx, w, flusher, keepalive, ws.WatchResumeDelay()) {
			return nil
		}
	}
}

// helmWatchCount is how many watches the stream opens: one per namespace of a grant limited to them.
func helmWatchCount(ctx context.Context, namespace string) int {
	if scope := k8s.CallerScope(ctx); namespace == "" && len(scope) > 0 {
		return len(scope)
	}
	return 1
}

// holdHelmWatches takes n of the server's live watches, telling the page and asking again later while they do not fit.
// release is nil when the stream ended first; told says the page was told.
func (h *Handler) holdHelmWatches(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, keepalive *time.Ticker, n int) (release func(), told bool, err error) {
	if h.watchLimits == nil {
		return func() {}, false, nil
	}
	for {
		if release, ok := h.watchLimits.HoldWatches(n); ok {
			return release, told, nil
		}
		if err := writeSSEEvent(w, flusher, "error", helmLimitFrame); err != nil {
			return nil, told, err
		}
		told = true
		if !keepAliveFor(ctx, w, flusher, keepalive, helmLimitRetry()) {
			return nil, told, nil
		}
	}
}

// keepAliveFor waits d, writing the keepalive comment meanwhile; false when the stream ended first.
func keepAliveFor(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, keepalive *time.Ticker, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		case <-keepalive.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return false
			}
			flusher.Flush()
		}
	}
}

// startSecretWatch opens the Secret watch with the helm release fieldSelector, each watch taking one of the cluster's
// places for starting a watch as a socket's watch does.
func (h *Handler) startSecretWatch(ctx context.Context, namespace string) (watch.Interface, error) {
	timeout := ws.WatchTimeoutSeconds()
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

	open := func(ns string) (watch.Interface, error) {
		if h.watchLimits != nil {
			id, _ := cluster.FromContext(ctx)
			release, err := h.watchLimits.StartWatch(ctx, string(id))
			if err != nil {
				return nil, err
			}
			defer release()
		}
		return cs.CoreV1().Secrets(ns).Watch(ctx, opts)
	}
	if scope := k8s.CallerScope(ctx); namespace == "" && len(scope) > 0 {
		return watchNamespaces(scope, open)
	}
	return open(namespace)
}

// watchNamespaces opens one watch per namespace of a grant limited to namespaces, leaving out one the cluster refuses
// unless all are, as the lists do. Their events come through one channel, which closes when the first watch ends, so
// the caller opens them all again.
func watchNamespaces(scope []string, open func(namespace string) (watch.Interface, error)) (watch.Interface, error) {
	m := &mergedWatch{out: make(chan watch.Event), done: make(chan struct{})}
	var skipped error
	for _, ns := range scope {
		w, err := open(ns)
		if err != nil {
			if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
				skipped = err
				continue
			}
			m.Stop()
			return nil, err
		}
		m.watchers = append(m.watchers, w)
	}
	if len(m.watchers) == 0 {
		return nil, skipped
	}
	var running sync.WaitGroup
	for _, w := range m.watchers {
		running.Add(1)
		go func(w watch.Interface) {
			defer running.Done()
			defer m.Stop()
			for {
				select {
				case <-m.done:
					return
				case event, ok := <-w.ResultChan():
					if !ok {
						return
					}
					select {
					case m.out <- event:
					case <-m.done:
						return
					}
				}
			}
		}(w)
	}
	go func() {
		running.Wait()
		close(m.out)
	}()
	return m, nil
}

// mergedWatch is the namespaces' watches as one (watchNamespaces).
type mergedWatch struct {
	watchers []watch.Interface
	out      chan watch.Event
	done     chan struct{}
	stop     sync.Once
}

func (m *mergedWatch) ResultChan() <-chan watch.Event { return m.out }

func (m *mergedWatch) Stop() {
	m.stop.Do(func() {
		close(m.done)
		for _, w := range m.watchers {
			w.Stop()
		}
	})
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
