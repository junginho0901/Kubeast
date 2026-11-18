package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// helmLimitRetry is the wait before a stream the server's limit of live watches refused asks again: half a minute to
// five, as a page the sockets refused asks again, so what was refused together does not come back together.
var helmLimitRetry = func() time.Duration { return 30*time.Second + rand.N(270*time.Second) }

// helmResumeDelay is the wait before a watch of the stream that ended goes on, spread as the sockets' watches are.
var helmResumeDelay = ws.WatchResumeDelay

// helmStreamID starts the stream's event id, which a browser that opens the stream again by itself sends back as
// Last-Event-ID (helmStreamPlace.id). Alone it names no version: the stream before this one ended, and what was
// deleted between the two only a read of the list can tell.
const helmStreamID = "helm-releases"

// helmStreamIDMax is the longest id the stream writes with versions: the browser sends it back as a request header,
// which nginx holds to a buffer of 8 KiB by default. A longer one is written as helmStreamID alone.
var helmStreamIDMax = 4 << 10

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
// Path: GET /api/v1/helm/releases/stream?namespace=&cluster=default&resync=1
//
//   - namespace empty → cluster-wide watch
//   - cluster query selects the target cluster (ClientsetFor(ctx), via
//     ClusterMiddleware); absent → default cluster.
//   - a Last-Event-ID the stream wrote (the browser opened it again) names the cluster's client and the version each
//     of its watches goes on from, so only what changed since comes, on whichever server built the same client.
//   - resync=1 (the page's list was read before this stream) or a Last-Event-ID naming no version of this stream's
//     watches asks for one 'resync' event once the watch is on, as a socket's REQUEST with resync gets one RESYNC.
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

	namespace := r.URL.Query().Get("namespace")
	scope := helmWatchNamespaces(r.Context(), namespace)
	place := &helmStreamPlace{namespace: namespace, perNamespace: scope != nil, from: helmWatchVersions{}, unplaced: map[string]bool{}}
	if id, version, ok := h.svc.ClientOf(r.Context()); ok {
		place.client = clientPlace(id, version) + "/" + personTag(r.Context(), id)
	}
	client, from, resumed := parseHelmStreamID(r.Header.Get("Last-Event-ID"))
	if resumed = resumed && place.client != "" && client == place.client && from.fits(scope, namespace); resumed {
		place.from = from
	}
	resync := !resumed && (r.URL.Query().Get("resync") == "1" || r.Header.Get("Last-Event-ID") != "")
	if err := place.tell(w, flusher); err != nil {
		return
	}

	ctx, release := h.holdSession(r.Context())
	defer release()
	if err := h.runHelmWatchSSE(ctx, w, flusher, place, resync, resumed); err != nil {
		slog.Warn("helm watch sse ended with error", "err", err, "namespace", namespace)
	}
	sayStreamEnded(ctx, w, flusher)
}

// runHelmWatchSSE is the long-lived loop that streams Secret events as SSE
// frames. Returns when the request context is cancelled (client disconnect)
// or when a non-recoverable error happens. K8s watcher 의 server-side
// TimeoutSeconds 가 차면 자동으로 새 watcher 를 열어 transparent reconnect.
// The next watch goes on from the last version the stream saw, so nothing between the two is lost; when that version
// has expired it starts from none and the page is told to read its list again ('resync'), as forwardEvents does.
// The first watches go on from the versions in place, which resumed says the browser brought.
func (h *Handler) runHelmWatchSSE(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, place *helmStreamPlace, resync, resumed bool) error {
	namespace := place.namespace
	// The same 25 s as the terminals and the other streams, under the 60 s idle cut of nginx and load balancers.
	keepalive := time.NewTicker(keepalivePeriod)
	defer keepalive.Stop()

	// The stream's watches count against the server's live watches while it is open (multicluster.wsMaxSubscriptions).
	// The retry wait is read once here, as keepalivePeriod above: the stream runs on until its request ends.
	release, told, err := h.holdHelmWatches(ctx, w, flusher, keepalive, helmWatchCount(ctx, namespace), helmLimitRetry)
	if release == nil {
		return err
	}
	defer release()
	// The page was told the limit kept it from following: what changed meanwhile only a read can tell.
	resync = resync || told

	for {
		if ctx.Err() != nil {
			return nil
		}

		watcher, err := h.startSecretWatch(ctx, namespace, place.from)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// An expired version, or a watch from the browser's versions that could not start: the watches start from
			// none, as a stream that brought none, and the browser's id names no version until they have a place again.
			if len(place.from) > 0 && (resumed || ws.ResourceVersionExpired(err)) {
				place.restart()
				resumed = false
				resync = true
				if err := place.tell(w, flusher); err != nil {
					return err
				}
				continue
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
		resumed = false
		place.started(watcher)
		// the page was told the limit kept it from following: it follows again
		if told {
			told = false
			if err := writeSSEEvent(w, flusher, "following", "{}"); err != nil {
				watcher.Stop()
				return err
			}
		}
		// Only now that the new watch is on: what is deleted after the page reads its list still reaches it as an event.
		if resync {
			resync = false
			if err := writeSSEEvent(w, flusher, "resync", "{}"); err != nil {
				watcher.Stop()
				return err
			}
		}

		expired, err := h.consumeWatchSSE(ctx, w, flusher, watcher, keepalive, place)
		watcher.Stop()
		if err != nil {
			return err
		}
		if expired && len(place.from) > 0 {
			place.restart()
			resync = true
			if err := place.tell(w, flusher); err != nil {
				return err
			}
		}

		// K8s 의 TimeoutSeconds 가 차서 watcher 가 닫혔다. A moment's spread, as the sockets' watches go on, then a new one.
		if !keepAliveFor(ctx, w, flusher, keepalive, helmResumeDelay()) {
			return nil
		}
	}
}

// helmWatchCount is how many watches the stream opens: one per namespace of a grant limited to them.
func helmWatchCount(ctx context.Context, namespace string) int {
	return max(len(helmWatchNamespaces(ctx, namespace)), 1)
}

// helmWatchNamespaces is the namespaces the stream watches one by one, a grant limited to namespaces asking for all of
// them; nil when one watch follows the namespace asked for ("" for all).
func helmWatchNamespaces(ctx context.Context, namespace string) []string {
	if scope := k8s.CallerScope(ctx); namespace == "" && len(scope) > 0 {
		return scope
	}
	return nil
}

// helmWatchVersions is what each of a stream's watches goes on from when it opens again: the version of the last event
// or bookmark it brought, by the namespace it follows ("" for all). A watch with none starts from no version and sends
// an ADDED for each release Secret there is.
type helmWatchVersions map[string]string

// helmStreamPlace is where a stream's watches are, and the event id the browser was last given of it.
type helmStreamPlace struct {
	namespace    string // asked for, "" for all
	perNamespace bool   // one watch per namespace of a grant limited to them
	// client names the cluster's client the watches read through (clientPlace) and who reads them (personTag).
	// Versions are its API server's: another API server opens a watch from a version it has not reached and sends
	// nothing until it does. What the page shows came of what that person may see there.
	client string
	from   helmWatchVersions
	// unplaced are the watches opened from no version whose first bookmark has not come: their first events are each
	// object's last version, in name order, which is no place in the stream to go on from
	unplaced map[string]bool
	said     string // the id the browser has
}

// clientPlace names a cluster's client by the cluster and the registry config_version it was built from, the same on
// every server that built it from the same registration.
func clientPlace(id cluster.ID, version int64) string {
	return url.PathEscape(string(id)) + "/" + strconv.FormatInt(version, 10)
}

// personTag names who reads a stream and what of the cluster they may see: the person (or API key, or system token),
// their role there and the namespaces their grant is limited to, none being the whole cluster. It is a short hash, the
// same on every server and holding no name, so a stream the browser opens again as someone else, or with another role
// or grant, starts over: the rows on the page came of what the one before could see.
func personTag(ctx context.Context, id cluster.ID) string {
	p, _ := auth.FromContext(ctx)
	a := p.Access(string(id), false)
	scope := slices.Clone(a.Namespaces)
	slices.Sort(scope)
	who, _ := json.Marshal([]any{p.UserID, a.Kind, a.APIKey, p.System, a.Role, scope})
	sum := sha256.Sum256(who)
	return hex.EncodeToString(sum[:8])
}

// id is the stream's event id: helmStreamID, the client, then each watch's version by its namespace as a query
// ("=<version>" for one watch of every namespace). It holds only what the registry and the API server gave, so two
// servers that brought the same events give the same id. While a watch has no place, or past helmStreamIDMax, it is
// helmStreamID alone, which a stream opened again reads as no version.
func (p *helmStreamPlace) id() string {
	if p.client == "" || len(p.from) == 0 || len(p.unplaced) > 0 {
		return helmStreamID
	}
	q := url.Values{}
	for namespace, version := range p.from {
		q.Set(namespace, version)
	}
	if id := helmStreamID + "/" + p.client + "?" + q.Encode(); len(id) <= helmStreamIDMax {
		return id
	}
	return helmStreamID
}

// started notes the watches a start opened: one from no version has no place until its first bookmark.
func (p *helmStreamPlace) started(watcher watch.Interface) {
	watched := []string{p.namespace}
	if m, ok := watcher.(*mergedWatch); ok {
		watched = m.namespaces
	}
	for _, namespace := range watched {
		if p.from[namespace] == "" {
			p.unplaced[namespace] = true
		}
	}
}

// keep moves the place of an event's watch, the namespace asked for or with one watch per namespace the event's own
// (watchNamespaces names a bookmark's), to its version. A bookmark places its watch: the API server sends it once the
// events before it are out.
func (p *helmStreamPlace) keep(secret *corev1.Secret, bookmark bool) {
	watched := p.namespace
	if p.perNamespace {
		watched = secret.Namespace
	}
	if secret.ResourceVersion != "" {
		p.from[watched] = secret.ResourceVersion
	}
	if bookmark {
		delete(p.unplaced, watched)
	}
}

// restart drops every place: the next watches start from no version.
func (p *helmStreamPlace) restart() {
	clear(p.from)
	clear(p.unplaced)
}

// tell writes the id as an id with no data when the browser has another: it keeps it for its next request of the
// stream and dispatches nothing.
func (p *helmStreamPlace) tell(w io.Writer, flusher http.Flusher) error {
	if p.id() == p.said {
		return nil
	}
	if _, err := io.WriteString(w, p.idLine()+"\n"); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

// idLine is the id line of the next frame, empty when the browser has that id already.
func (p *helmStreamPlace) idLine() string {
	id := p.id()
	if id == p.said {
		return ""
	}
	p.said = id
	return "id: " + id + "\n"
}

// parseHelmStreamID reads an id the stream wrote with versions: the client it names and each watch's version. Anything
// else, a version that is not a whole number from 1 ("0" is any version) too, is no place to go on from.
func parseHelmStreamID(s string) (client string, from helmWatchVersions, ok bool) {
	rest, ok := strings.CutPrefix(s, helmStreamID+"/")
	if !ok {
		return "", nil, false
	}
	client, query, ok := strings.Cut(rest, "?")
	if !ok || client == "" {
		return "", nil, false
	}
	q, err := url.ParseQuery(query)
	if err != nil || len(q) == 0 {
		return "", nil, false
	}
	from = helmWatchVersions{}
	for namespace, versions := range q {
		if len(versions) != 1 || !wholeVersion(versions[0]) {
			return "", nil, false
		}
		from[namespace] = versions[0]
	}
	return client, from, true
}

// wholeVersion is a resourceVersion as the API server writes one: a whole number from 1, in decimal.
func wholeVersion(v string) bool {
	if v == "" || v[0] < '1' || v[0] > '9' {
		return false
	}
	for _, c := range v {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// fits says the versions are of watches this stream opens: the namespace asked for, or namespaces of the grant
// (helmWatchNamespaces' scope). One the grant no longer has is not: what the page shows of it only a read can tell.
func (v helmWatchVersions) fits(scope []string, namespace string) bool {
	if scope == nil {
		_, ok := v[namespace]
		return ok && len(v) == 1
	}
	for watched := range v {
		if !slices.Contains(scope, watched) {
			return false
		}
	}
	return true
}

// holdHelmWatches takes n of the server's live watches, telling the page and asking again after retry() while they do
// not fit. release is nil when the stream ended first; told says the page was told.
func (h *Handler) holdHelmWatches(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, keepalive *time.Ticker, n int, retry func() time.Duration) (release func(), told bool, err error) {
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
		if !keepAliveFor(ctx, w, flusher, keepalive, retry()) {
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
// places for starting a watch as a socket's watch does, and going on from its version in from.
func (h *Handler) startSecretWatch(ctx context.Context, namespace string, from helmWatchVersions) (watch.Interface, error) {
	timeout := ws.WatchTimeoutSeconds()
	opts := metav1.ListOptions{
		FieldSelector: "type=" + helm.SecretType,
		Watch:         true,
		// Keeps the version to go on from recent while no release changes, where the last event's may be long expired.
		AllowWatchBookmarks: true,
		TimeoutSeconds:      &timeout,
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
		o := opts
		o.ResourceVersion = from[ns]
		return cs.CoreV1().Secrets(ns).Watch(ctx, o)
	}
	if scope := helmWatchNamespaces(ctx, namespace); scope != nil {
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
		m.namespaces = append(m.namespaces, ns)
	}
	if len(m.watchers) == 0 {
		return nil, skipped
	}
	var running sync.WaitGroup
	for i, w := range m.watchers {
		running.Add(1)
		go func(w watch.Interface, ns string) {
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
					// A bookmark carries only a version: the namespace whose watch goes on from it.
					if secret, isSecret := event.Object.(*corev1.Secret); isSecret && event.Type == watch.Bookmark && secret.Namespace == "" {
						secret.Namespace = ns
					}
					select {
					case m.out <- event:
					case <-m.done:
						return
					}
				}
			}
		}(w, m.namespaces[i])
	}
	go func() {
		running.Wait()
		close(m.out)
	}()
	return m, nil
}

// mergedWatch is the namespaces' watches as one (watchNamespaces).
type mergedWatch struct {
	watchers   []watch.Interface
	namespaces []string // each watcher's
	out        chan watch.Event
	done       chan struct{}
	stop       sync.Once
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
// Every Secret's version, a bookmark's too, moves place; a release's frame carries the id when it moved, and the place
// bookmarks moved it to goes with the next keepalive, so a quiet stream's id keeps up with the version, which expires,
// at one line a keepalive however many namespaces it watches. expired says the API server ended the watch because the
// version it went on from has expired.
func (h *Handler) consumeWatchSSE(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, watcher watch.Interface, keepalive *time.Ticker, place *helmStreamPlace) (expired bool, err error) {
	results := watcher.ResultChan()
	for {
		select {
		case <-ctx.Done():
			return false, nil

		case <-keepalive.C:
			if err := place.tell(w, flusher); err != nil {
				return false, err
			}
			// SSE comment 라인 — 브라우저 EventSource 가 무시. proxy/LB idle
			// timeout 만 막아준다. 이전 WebSocket 의 ping/pong 대체.
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return false, err
			}
			flusher.Flush()

		case event, ok := <-results:
			if !ok {
				return false, nil
			}

			if event.Type == watch.Error {
				failure := apierrors.FromObject(event.Object)
				if ws.ResourceVersionExpired(failure) {
					return true, nil
				}
				slog.Warn("helm watch error event", "err", failure)
				continue
			}
			secret, ok := event.Object.(*corev1.Secret)
			if !ok {
				continue
			}
			place.keep(secret, event.Type == watch.Bookmark)
			if event.Type == watch.Bookmark {
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
			if _, err := fmt.Fprintf(w, "%sdata: %s\n\n", place.idLine(), payload); err != nil {
				return false, err
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
