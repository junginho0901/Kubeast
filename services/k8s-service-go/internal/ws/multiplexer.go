package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
	"github.com/junginho0901/kubeast/services/pkg/response"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: CheckOrigin,
}

// WebSocket keepalive parameters.
//
// nginx proxy_read_timeout 기본값 60초 → 60초 동안 watch 이벤트 없으면
// connection 이 idle 로 판단되어 끊김. 60초 사이의 K8s 변화는 영원히 lost
// (새 watch 시작 시 LIST 안 보냄). 해결: 25초마다 ws ping 보내 nginx 가
// traffic 으로 인식하게. ReadDeadline 은 dead connection 빠른 정리용.
const (
	pingPeriod = 25 * time.Second
	pongWait   = 60 * time.Second
	writeWait  = 10 * time.Second
)

// RequestMessage is the client request for a watch subscription.
type RequestMessage struct {
	Type      string `json:"type"`      // "REQUEST"
	ClusterID string `json:"clusterId"` // e.g. "default"
	Path      string `json:"path"`      // e.g. "/api/v1/pods"
	Query     string `json:"query"`     // e.g. "watch=true&..."
	// Resync asks for one RESYNC once the watch is on: the client missed what happened before this watch.
	Resync bool `json:"resync,omitempty"`
}

// notifyParam in a REQUEST's query asks to hear that something changed instead of each object (CHANGED).
const notifyParam = "notify"

// changedEvery is the most often a watch that only tells of changes says so.
const changedEvery = time.Second

// ResponseMessage is sent back to the client.
type ResponseMessage struct {
	Type      string      `json:"type"`                // "DATA", "ERROR", "RESYNC" (read the list again) or "CHANGED" (what the watch covers changed)
	ClusterID string      `json:"clusterId,omitempty"` // the cluster its REQUEST named
	Path      string      `json:"path"`                // original path
	Query     string      `json:"query"`               // original query string
	Data      interface{} `json:"data,omitempty"`      // watch event data
	Error     interface{} `json:"error,omitempty"`     // error info
}

// frame answers r under the names it asked with, the one thing telling the same path on two clusters apart.
func (r RequestMessage) frame(kind string) ResponseMessage {
	return ResponseMessage{Type: kind, ClusterID: r.ClusterID, Path: r.Path, Query: r.Query}
}

// Why a watch has no data, as the screen reads it (the message stays the server's English).
const (
	reasonForbidden   = "forbidden"   // the app or the cluster refuses it
	reasonLimit       = "limit"       // too many watches on this connection or this server
	reasonUnreachable = "unreachable" // the cluster did not answer; the watch keeps trying
	reasonFailed      = "failed"      // the cluster answered with an error; the watch keeps trying
	reasonNotServed   = "not_served"  // the cluster does not serve the kind, which its list says
	reasonUnsupported = "unsupported" // a resource this socket has no live updates for
	reasonScope       = "scope"       // a kind no namespace holds, for a grant limited to namespaces
)

// Which limit a reasonLimit frame hit (limit_scope): closing a tab frees the tab's, not the server's.
const (
	limitScopeTab    = "tab"
	limitScopeServer = "server"
)

func (r RequestMessage) errorFrame(message, reason string) ResponseMessage {
	f := r.frame("ERROR")
	f.Error = map[string]string{"message": message, "reason": reason}
	return f
}

func (r RequestMessage) limitFrame(message, scope string) ResponseMessage {
	f := r.frame("ERROR")
	f.Error = map[string]string{"message": message, "reason": reasonLimit, "limit_scope": scope}
	return f
}

// watchFailure is a failed watch as the client may read it: an error the API server wrote stays, a failed call's
// address does not.
func watchFailure(err error) (message, reason string) {
	var status apierrors.APIStatus
	switch {
	case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
		return err.Error(), reasonForbidden
	case apierrors.IsNotFound(err):
		return err.Error(), reasonNotServed
	case errors.As(err, &status):
		return response.Public(err), reasonFailed
	}
	return response.Public(err), reasonUnreachable
}

// send queues a frame unless ctx ends first: with a slow client or a dead writer the queue may never have room.
func send(ctx context.Context, sendCh chan<- ResponseMessage, f ResponseMessage) bool {
	select {
	case sendCh <- f:
		return true
	case <-ctx.Done():
		return false
	}
}

// pause waits d and reports whether ctx is still live.
func pause(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

type subscription struct {
	cancel context.CancelFunc
}

const (
	// defaultMaxSubscriptions caps watches across every connection — 2 000
	// is 500 people with four node boxes of Cluster View each (200 cut the
	// live updates past 50 of them); defaultMaxSubscriptionsPerConn caps one
	// browser tab so a single client cannot exhaust the global budget (second
	// review L22).
	defaultMaxSubscriptions        = 2000
	defaultMaxSubscriptionsPerConn = 50
	// defaultWatchStartsAtOnce: at 50 ms a start, 16 bring 2 000 subscriptions back in about six seconds.
	defaultWatchStartsAtOnce = 16
	// maxFrameBytes bounds a client → server frame: a REQUEST/CLOSE message
	// is a few hundred bytes; anything larger is not ours (M30).
	maxFrameBytes = 64 * 1024
)

// ClientProvider supplies K8s clients at use-time so hot-reload of the
// underlying clientBundle is transparent to long-lived subscriptions.
type ClientProvider interface {
	Clientset() *kubernetes.Clientset
	Dynamic() dynamic.Interface
	// DynamicForCtx targets the cluster carried in ctx (value-or-nil).
	DynamicForCtx(ctx context.Context) dynamic.Interface
}

// GVRResolver, which the k8s Service implements, names the version the cluster in ctx serves a resource at.
type GVRResolver interface {
	ResolveGVR(ctx context.Context, group, resource string) (schema.GroupVersionResource, bool)
}

// servedVersion watches a Gateway API or DRA resource at the version the cluster serves (Gateway API mixes versions
// and moves them between releases; resource.k8s.io is v1 since 1.34, a beta before), as the list API reads it; other
// resources keep their fixed version.
func (m *Multiplexer) servedVersion(ctx context.Context, gvr schema.GroupVersionResource) schema.GroupVersionResource {
	r, ok := m.provider.(GVRResolver)
	if !ok || (gvr.Group != "gateway.networking.k8s.io" && gvr.Group != "resource.k8s.io") {
		return gvr
	}
	if served, ok := r.ResolveGVR(ctx, gvr.Group, gvr.Resource); ok {
		return served
	}
	return gvr
}

// Multiplexer handles multiplexed WebSocket watch connections.
type Multiplexer struct {
	// MaxSubscriptions / MaxSubscriptionsPerConn: 0 = the defaults above.
	MaxSubscriptions        int
	MaxSubscriptionsPerConn int
	// Sessions ends a socket whose session stopped standing (nil: not checked).
	Sessions *auth.LiveSessions
	// PanicRetryDelay is the wait after a panic; 0 = the five seconds a failed watch waits.
	PanicRetryDelay time.Duration
	provider        ClientProvider

	// MaxWatchStarts is how many watches of one cluster may be starting at once: 0 = the default above.
	MaxWatchStarts int

	// startNoticeAfter and startHoldFor: see takeWatchStart.
	startNoticeAfter time.Duration
	startHoldFor     time.Duration

	mu     sync.Mutex
	subs   map[string]*subscription // key -> subscription
	starts map[string]*limits.Slots // cluster -> places for starting a watch
}

// SubscriptionCount is the number of live subscriptions across all connections (metrics).
func (m *Multiplexer) SubscriptionCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.subs)
}

// subscriptionCluster is the cluster a REQUEST targets: its own clusterId, or
// the connection's cluster that the HTTP ClusterMiddleware resolved.
func subscriptionCluster(ctx context.Context, id string) string {
	if id == "" {
		if c, ok := cluster.FromContext(ctx); ok {
			return string(c)
		}
	}
	return id
}

// effectiveClusterID is what an empty clusterId is authorized as when no
// connection cluster is known (the connection always carries one in the server).
func effectiveClusterID(id string) string {
	if id == "" {
		return string(cluster.Default)
	}
	return id
}

// canWatchCluster is the per-subscription authorization: a global admin ("*") or a per-cluster grant on the effective
// cluster (deny-by-default).
func canWatchCluster(payload auth.TokenPayload, clusterID string) bool {
	return payload.ReachesCluster(effectiveClusterID(clusterID))
}

// NewMultiplexer creates a new WebSocket multiplexer.
func NewMultiplexer(p ClientProvider) *Multiplexer {
	return &Multiplexer{
		provider:         p,
		subs:             make(map[string]*subscription),
		starts:           make(map[string]*limits.Slots),
		startNoticeAfter: 10 * time.Second,
		startHoldFor:     5 * time.Second,
	}
}

// HandleWebSocket handles the /wsMultiplexer endpoint.
func (m *Multiplexer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// The JWT middleware gated the connection on ?cluster=; every REQUEST
	// message names its own clusterId, so each subscription is gated again.
	payload, _ := auth.FromContext(r.Context())

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxFrameBytes)

	wsID := fmt.Sprintf("%p", conn)
	slog.Info("ws connected", "id", wsID)
	maxTotal, maxPerConn := m.MaxSubscriptions, m.MaxSubscriptionsPerConn
	if maxTotal <= 0 {
		maxTotal = defaultMaxSubscriptions
	}
	if maxPerConn <= 0 {
		maxPerConn = defaultMaxSubscriptionsPerConn
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// Every watch of this socket hangs off the session it opened with.
	ctx, release := m.Sessions.Hold(ctx, payload)
	defer release()

	// Keepalive: pong 받을 때마다 ReadDeadline 갱신. 60초 안에 pong 없으면
	// ReadMessage 가 timeout 으로 break → defer 의 disconnect 처리.
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Channel to send messages to client
	sendCh := make(chan ResponseMessage, 256)

	// Writer goroutine — DATA/ERROR 메시지 송신 + 25초마다 ping.
	go func() {
		// Nothing else drains sendCh: a dead writer has to end the connection, or what waits on the queue stays for good.
		defer func() {
			cancel()
			_ = conn.Close()
		}()
		// This socket and no other. The wait comes before the close, since the browser connects again and asks for its lists.
		defer func() {
			if r := recover(); r != nil {
				logPanic("ws writer panicked: this connection ends", r, "id", wsID)
				pause(ctx, m.panicWait())
			}
		}()
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				if code := auth.SessionEndCode(ctx); code != "" {
					slog.Info("ws closed: session ended", "id", wsID, "user", payload.UserID, "reason", code)
					_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(auth.SessionEndedCloseCode, code), time.Now().Add(writeWait))
				}
				return
			case msg, ok := <-sendCh:
				if !ok {
					return
				}
				data, err := json.Marshal(msg)
				if err != nil {
					continue
				}
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	// This connection's live watches, under m.mu: the part of m.subs that counts against its own limit.
	connSubs := make(map[string]*subscription)
	defer func() {
		m.mu.Lock()
		for key, sub := range connSubs {
			sub.cancel()
			delete(m.subs, key)
		}
		m.mu.Unlock()
		slog.Info("ws disconnected", "id", wsID)
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var req RequestMessage
		if err := json.Unmarshal(message, &req); err != nil {
			continue
		}
		clusterID := subscriptionCluster(ctx, req.ClusterID)

		key := fmt.Sprintf("%s:%s:%s?%s", wsID, clusterID, req.Path, req.Query)

		switch req.Type {
		case "REQUEST":
			if !canWatchCluster(payload, clusterID) {
				send(ctx, sendCh, req.errorFrame("forbidden: no access to cluster "+effectiveClusterID(clusterID), reasonForbidden))
				continue
			}
			// What the list route asks, once per subscription: a frame carries no new question.
			if !payload.HasPermissionForCluster(auth.PermObjectsRead, effectiveClusterID(clusterID)) {
				send(ctx, sendCh, req.errorFrame("forbidden: requires "+auth.PermObjectsRead+" permission in cluster "+effectiveClusterID(clusterID), reasonForbidden))
				continue
			}
			if refusal := namespaceScopeRefusalOf(payload, effectiveClusterID(clusterID), req.Path, req.Query); refusal != "" {
				send(ctx, sendCh, req.errorFrame(refusal, namespaceScopeReason(req.Path)))
				continue
			}
			if refusal := m.protectedRefusal(ctx, payload, effectiveClusterID(clusterID), req.Path); refusal != "" {
				send(ctx, sendCh, req.errorFrame(refusal, reasonForbidden))
				continue
			}

			// Skip if already subscribed
			m.mu.Lock()
			if _, exists := m.subs[key]; exists {
				m.mu.Unlock()
				continue
			}

			// Reject if this connection's or the global cap is reached
			if len(connSubs) >= maxPerConn || len(m.subs) >= maxTotal {
				limit, scope, limitScope := maxPerConn, "this connection", limitScopeTab
				if len(connSubs) < maxPerConn {
					limit, scope, limitScope = maxTotal, "the server", limitScopeServer
				}
				m.mu.Unlock()
				send(ctx, sendCh, req.limitFrame(fmt.Sprintf("max subscriptions reached for %s (%d), cannot create new watch", scope, limit), limitScope))
				continue
			}

			subCtx, subCancel := context.WithCancel(ctx)
			// Carry the target cluster so the watch hits the right cluster.
			if clusterID != "" {
				subCtx = cluster.WithID(subCtx, cluster.ID(clusterID))
			}
			sub := &subscription{cancel: subCancel}
			m.subs[key] = sub
			connSubs[key] = sub
			m.mu.Unlock()

			go func() {
				defer m.forgetSubscription(key, sub, connSubs)
				// The check runs before runWatch and its recover.
				defer func() {
					if r := recover(); r != nil {
						logPanic("watch check panicked: this watch ends", r, "path", req.Path, "cluster", req.ClusterID)
						send(ctx, sendCh, req.errorFrame("this list could not be followed; open the page again", reasonFailed))
					}
				}()
				if refusal := m.clusterListRefusal(subCtx, payload, effectiveClusterID(clusterID), req); refusal != "" {
					send(ctx, sendCh, req.errorFrame(refusal, reasonScope))
					return
				}
				m.runWatch(subCtx, req, sendCh)
			}()

		case "CLOSE":
			m.mu.Lock()
			if sub, ok := connSubs[key]; ok {
				sub.cancel()
				delete(m.subs, key)
				delete(connSubs, key)
			}
			m.mu.Unlock()
		}
	}
}

// watchRetryDelay is the wait before a failed watch tries again: five seconds, give or take two, so what failed together
// does not come back together.
func watchRetryDelay() time.Duration { return 3*time.Second + rand.N(4*time.Second) }

// watchResumeDelay is the wait before a watch that ended goes on: a second, give or take a half. An API server restart
// ends every watch at one moment.
func watchResumeDelay() time.Duration { return 500*time.Millisecond + rand.N(time.Second) }

// watchTimeoutSeconds is what a watch asks the API server to run for, five minutes give or take thirty seconds: the
// watches a restart started together would otherwise end together every five minutes from then on.
func watchTimeoutSeconds() int64 { return 270 + rand.Int64N(61) }

// watchStartPlaces are the places for starting a watch on a cluster. client-go does not rate limit watches, so without
// them every subscription of a restart reaches the API server at the same moment. Holding a place is only the wait for
// the API server's first answer; a watch that is on holds none.
func (m *Multiplexer) watchStartPlaces(id string) *limits.Slots {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.starts[id] == nil {
		n := m.MaxWatchStarts
		if n <= 0 {
			n = defaultWatchStartsAtOnce
		}
		m.starts[id] = limits.NewSlots("watch start on "+id, n)
	}
	return m.starts[id]
}

// takeWatchStart waits for a place to start req's watch, which costs one parked goroutine and no frames. A wait past
// startNoticeAfter is told to the client, whose list is not following meanwhile; told says the next watch has to say
// it is back. ok is false when ctx ended. The place goes back by the time release is called or the API server has kept
// the start waiting for startHoldFor, whichever comes first, so a server that does not answer does not stop the queue.
func (m *Multiplexer) takeWatchStart(ctx context.Context, req RequestMessage, sendCh chan<- ResponseMessage) (release func(), told, ok bool) {
	places := m.watchStartPlaces(effectiveClusterID(subscriptionCluster(ctx, req.ClusterID)))
	waiting, stop := context.WithTimeout(ctx, m.startNoticeAfter)
	give, err := places.Take(waiting)
	stop()
	if err != nil {
		if ctx.Err() != nil || !send(ctx, sendCh, req.errorFrame("waiting for a turn to start following the cluster", reasonUnreachable)) {
			return nil, false, false
		}
		told = true
		if give, err = places.Take(ctx); err != nil {
			return nil, told, false
		}
	}
	once := sync.OnceFunc(give)
	timer := time.AfterFunc(m.startHoldFor, once)
	return func() {
		timer.Stop()
		once()
	}, told, true
}

// forgetSubscription frees the place of a watch that has ended, unless a later REQUEST of the same key already holds it.
func (m *Multiplexer) forgetSubscription(key string, sub *subscription, connSubs map[string]*subscription) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sub.cancel()
	if m.subs[key] == sub {
		delete(m.subs, key)
		delete(connSubs, key)
	}
}

func (m *Multiplexer) panicWait() time.Duration {
	if m.PanicRetryDelay > 0 {
		return m.PanicRetryDelay
	}
	return watchRetryDelay()
}

// logPanic leaves a recovered panic's type and stack in the log and not its value, which may hold what an object held.
func logPanic(message string, value any, attrs ...any) {
	slog.Error(message, append(attrs, "panic_type", fmt.Sprintf("%T", value), "stack", string(debug.Stack()))...)
}

// resourceVersionExpired is the API server saying a watch cannot resume from the version it was asked for.
func resourceVersionExpired(err error) bool {
	return apierrors.IsResourceExpired(err) || apierrors.IsGone(err)
}

// watchProgress is what a watch goes on from after a panic.
type watchProgress struct {
	version string
	resync  bool
}

// runWatch follows req until its context ends or there is nothing to follow. Nothing above it recovers, so a panic on one
// object would end the service for everyone. It ends one try: the client is told, the wait keeps the same panic from
// spinning, and the watch goes on from its version, past that object, with the list read again.
func (m *Multiplexer) runWatch(ctx context.Context, req RequestMessage, sendCh chan<- ResponseMessage) {
	var progress watchProgress
	for m.watchPanicked(ctx, req, sendCh, &progress) {
		message := "this list could not be followed for a moment; it goes on by itself"
		if !send(ctx, sendCh, req.errorFrame(message, reasonFailed)) || !pause(ctx, m.panicWait()) {
			return
		}
		progress.resync = true
	}
}

// watchPanicked runs one try of req's watch and reports whether a panic ended it.
func (m *Multiplexer) watchPanicked(ctx context.Context, req RequestMessage, sendCh chan<- ResponseMessage, progress *watchProgress) (panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			logPanic("watch panicked: this watch tries again", r, "path", req.Path, "cluster", req.ClusterID)
		}
	}()
	m.followWatch(ctx, req, sendCh, progress)
	return false
}

func (m *Multiplexer) followWatch(ctx context.Context, req RequestMessage, sendCh chan<- ResponseMessage, progress *watchProgress) {
	resource, namespace, err := parsePath(req.Path)
	if err != nil {
		send(ctx, sendCh, req.errorFrame(err.Error(), reasonUnsupported))
		return
	}

	params := parseQuery(req.Query)
	labelSelector := params["labelSelector"]
	fieldSelector := params["fieldSelector"]
	notify := params[notifyParam] == "1"

	gvr, ok := watchTarget(req.Path, notify)
	if !ok {
		send(ctx, sendCh, req.errorFrame("unsupported resource: "+resource, reasonUnsupported))
		return
	}
	gvr = m.servedVersion(ctx, gvr)

	lastResourceVersion := progress.version
	// Kept on the way out of a panic too: forwardEvents moves the version before it makes the object's row.
	defer func() { progress.version = lastResourceVersion }()
	// A watch from no version sends the objects there are, not those deleted since, so the client has to read its list
	// again (Kubernetes API Concepts, "410 Gone responses").
	resync := progress.resync || req.Resync

	for {
		if ctx.Err() != nil {
			return
		}

		dyn := m.provider.DynamicForCtx(ctx)
		if dyn == nil {
			slog.Warn("watch waiting: kubeconfig not loaded", "resource", resource)
			if !send(ctx, sendCh, req.errorFrame("kubeconfig not loaded", reasonUnreachable)) || !pause(ctx, 5*time.Second) {
				return
			}
			resync = true
			continue
		}

		// A watch of changes starts from now: from no version it would send every object as it opens, for nobody to read.
		if notify && lastResourceVersion == "" {
			lastResourceVersion, err = currentResourceVersion(ctx, dyn, gvr, namespace)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				slog.Warn("watch failed", "resource", resource, "err", err)
				message, reason := watchFailure(err)
				if !send(ctx, sendCh, req.errorFrame(message, reason)) || !pause(ctx, watchRetryDelay()) {
					return
				}
				resync = true
				continue
			}
		}

		opts := metav1.ListOptions{
			Watch: true,
			// Keeps the version to resume from recent on a quiet list, where the last event's may be long expired.
			AllowWatchBookmarks: true,
			TimeoutSeconds:      int64Ptr(watchTimeoutSeconds()),
			ResourceVersion:     lastResourceVersion,
			LabelSelector:       labelSelector,
			FieldSelector:       fieldSelector,
		}

		release, told, ok := m.takeWatchStart(ctx, req, sendCh)
		if !ok {
			return
		}
		resync = resync || told
		var watcher watch.Interface
		if namespace != "" {
			watcher, err = dyn.Resource(gvr).Namespace(namespace).Watch(ctx, opts)
		} else {
			watcher, err = dyn.Resource(gvr).Watch(ctx, opts)
		}
		release()
		if err != nil {
			// Canceled while connecting: nobody is waiting for this watch, so it is no failure to report.
			if ctx.Err() != nil {
				return
			}
			if lastResourceVersion != "" && resourceVersionExpired(err) {
				lastResourceVersion, resync = "", true
				continue
			}
			slog.Warn("watch failed", "resource", resource, "err", err)
			message, reason := watchFailure(err)
			if !send(ctx, sendCh, req.errorFrame(message, reason)) || !pause(ctx, watchRetryDelay()) {
				return
			}
			// The client was told the list stopped following: the next watch says it is back, on a quiet list too.
			resync = true
			continue
		}

		// Only now that the new watch is on: what is deleted after the client reads its list still reaches it as an event.
		if resync {
			resync = false
			if !send(ctx, sendCh, req.frame("RESYNC")) {
				watcher.Stop()
				return
			}
		}

		var expired bool
		if notify {
			expired = forwardChanges(ctx, watcher, req, gvr.Resource, &lastResourceVersion, sendCh)
		} else {
			expired = forwardEvents(ctx, watcher, req, gvr.Resource, &lastResourceVersion, sendCh)
		}

		// Watch ended, retry
		if ctx.Err() != nil {
			return
		}
		if expired && lastResourceVersion != "" {
			lastResourceVersion, resync = "", true
		}
		if !pause(ctx, watchResumeDelay()) {
			return
		}
	}
}

// forwardEvents sends a watch's events until it ends, moving resourceVersion along, and reports whether the API server
// said that version has expired.
func forwardEvents(ctx context.Context, watcher watch.Interface, req RequestMessage, resource string, resourceVersion *string, sendCh chan<- ResponseMessage) bool {
	defer watcher.Stop()
	for event := range watcher.ResultChan() {
		if ctx.Err() != nil {
			return false
		}

		// The dynamic client decodes this event's object to a Status, not to the resource's kind.
		if event.Type == watch.Error {
			err := apierrors.FromObject(event.Object)
			if resourceVersionExpired(err) {
				return true
			}
			slog.Warn("watch error event", "resource", resource, "err", err)
			continue
		}

		obj, ok := event.Object.(*unstructured.Unstructured)
		if !ok {
			continue
		}

		rv := obj.GetResourceVersion()
		if rv != "" {
			*resourceVersion = rv
		}
		if event.Type == watch.Bookmark {
			continue
		}

		// resource is gvr.Resource: the path's own segment may be an alias ("pvs"), which objectToInfo would send as a partial object.
		f := req.frame("DATA")
		// Queued as its JSON: a socket behind holds 256 frames, and a row's map took some 8 KiB a pod.
		data, err := json.Marshal(map[string]interface{}{
			"type":   string(event.Type),
			"object": objectToInfo(resource, obj),
		})
		if err != nil {
			continue
		}
		f.Data = json.RawMessage(data)
		if !send(ctx, sendCh, f) {
			return false
		}
	}
	return false
}

// forwardChanges is forwardEvents for a watch of changes: one CHANGED on the first event and at most one every
// changedEvery while they keep coming, no object in it.
func forwardChanges(ctx context.Context, watcher watch.Interface, req RequestMessage, resource string, resourceVersion *string, sendCh chan<- ResponseMessage) bool {
	defer watcher.Stop()
	var wait <-chan time.Time
	held := false
	for {
		select {
		case <-ctx.Done():
			return false
		case <-wait:
			wait = nil
			if held {
				held = false
				if !send(ctx, sendCh, req.frame("CHANGED")) {
					return false
				}
				wait = time.After(changedEvery)
			}
		case event, open := <-watcher.ResultChan():
			if !open {
				// The next watch resumes after this event, so what was held would never be told.
				if held {
					send(ctx, sendCh, req.frame("CHANGED"))
				}
				return false
			}
			if event.Type == watch.Error {
				err := apierrors.FromObject(event.Object)
				if resourceVersionExpired(err) {
					return true
				}
				slog.Warn("watch error event", "resource", resource, "err", err)
				continue
			}
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			if rv := obj.GetResourceVersion(); rv != "" {
				*resourceVersion = rv
			}
			if event.Type == watch.Bookmark {
				continue
			}
			if wait != nil {
				held = true
				continue
			}
			if !send(ctx, sendCh, req.frame("CHANGED")) {
				return false
			}
			wait = time.After(changedEvery)
		}
	}
}

// currentResourceVersion is the cluster's version now, from a list of one item: without a selector it reads one object
// however many there are, and a selector would not change the answer.
func currentResourceVersion(ctx context.Context, dyn dynamic.Interface, gvr schema.GroupVersionResource, namespace string) (string, error) {
	var list *unstructured.UnstructuredList
	var err error
	opts := metav1.ListOptions{Limit: 1}
	if namespace != "" {
		list, err = dyn.Resource(gvr).Namespace(namespace).List(ctx, opts)
	} else {
		list, err = dyn.Resource(gvr).List(ctx, opts)
	}
	if err != nil {
		return "", err
	}
	return list.GetResourceVersion(), nil
}

// parsePath extracts resource type and optional namespace from K8s API path.
func parsePath(path string) (resource string, namespace string, err error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "api" || parts[1] != "v1" {
		// Try apps/v1 style: /apis/apps/v1/...
		if len(parts) >= 4 && parts[0] == "apis" {
			if len(parts) == 4 {
				return parts[3], "", nil
			}
			if len(parts) >= 6 && parts[3] == "namespaces" {
				return parts[5], parts[4], nil
			}
		}
		return "", "", fmt.Errorf("unsupported api path: %s", path)
	}

	// /api/v1/pods
	if len(parts) == 3 {
		return parts[2], "", nil
	}

	// /api/v1/namespaces/{ns}/pods
	if len(parts) >= 5 && parts[2] == "namespaces" {
		return parts[4], parts[3], nil
	}

	return "", "", fmt.Errorf("unsupported api path: %s", path)
}

func parseQuery(queryStr string) map[string]string {
	result := make(map[string]string)
	values, err := url.ParseQuery(queryStr)
	if err != nil {
		return result
	}
	for k, v := range values {
		if len(v) > 0 && k != "watch" {
			result[k] = v[0]
		}
	}
	return result
}

// watchKinds is every resource a watch can reach, by the path's last part.
var watchKinds = map[string]schema.GroupVersionResource{
	"pods":                     {Group: "", Version: "v1", Resource: "pods"},
	"services":                 {Group: "", Version: "v1", Resource: "services"},
	"nodes":                    {Group: "", Version: "v1", Resource: "nodes"},
	"namespaces":               {Group: "", Version: "v1", Resource: "namespaces"},
	"events":                   {Group: "", Version: "v1", Resource: "events"},
	"persistentvolumeclaims":   {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
	"pvcs":                     {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
	"persistentvolumes":        {Group: "", Version: "v1", Resource: "persistentvolumes"},
	"pvs":                      {Group: "", Version: "v1", Resource: "persistentvolumes"},
	"configmaps":               {Group: "", Version: "v1", Resource: "configmaps"},
	"secrets":                  {Group: "", Version: "v1", Resource: "secrets"},
	"endpoints":                {Group: "", Version: "v1", Resource: "endpoints"},
	"deployments":              {Group: "apps", Version: "v1", Resource: "deployments"},
	"statefulsets":             {Group: "apps", Version: "v1", Resource: "statefulsets"},
	"daemonsets":               {Group: "apps", Version: "v1", Resource: "daemonsets"},
	"replicasets":              {Group: "apps", Version: "v1", Resource: "replicasets"},
	"ingresses":                {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
	"ingressclasses":           {Group: "networking.k8s.io", Version: "v1", Resource: "ingressclasses"},
	"networkpolicies":          {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
	"endpointslices":           {Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"},
	"jobs":                     {Group: "batch", Version: "v1", Resource: "jobs"},
	"cronjobs":                 {Group: "batch", Version: "v1", Resource: "cronjobs"},
	"storageclasses":           {Group: "storage.k8s.io", Version: "v1", Resource: "storageclasses"},
	"volumeattachments":        {Group: "storage.k8s.io", Version: "v1", Resource: "volumeattachments"},
	"gateways":                 {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"},
	"gatewayclasses":           {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gatewayclasses"},
	"httproutes":               {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"},
	"grpcroutes":               {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "grpcroutes"},
	"referencegrants":          {Group: "gateway.networking.k8s.io", Version: "v1beta1", Resource: "referencegrants"},
	"backendtlspolicies":       {Group: "gateway.networking.k8s.io", Version: "v1alpha3", Resource: "backendtlspolicies"},
	"serviceaccounts":          {Group: "", Version: "v1", Resource: "serviceaccounts"},
	"roles":                    {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
	"horizontalpodautoscalers": {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
	"verticalpodautoscalers":   {Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"},
	"deviceclasses":            {Group: "resource.k8s.io", Version: "v1", Resource: "deviceclasses"},
	"resourceclaims":           {Group: "resource.k8s.io", Version: "v1", Resource: "resourceclaims"},
	"resourceclaimtemplates":   {Group: "resource.k8s.io", Version: "v1", Resource: "resourceclaimtemplates"},
	"resourceslices":           {Group: "resource.k8s.io", Version: "v1", Resource: "resourceslices"},

	"clusterroles":                    {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
	"clusterrolebindings":             {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
	"rolebindings":                    {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
	"priorityclasses":                 {Group: "scheduling.k8s.io", Version: "v1", Resource: "priorityclasses"},
	"runtimeclasses":                  {Group: "node.k8s.io", Version: "v1", Resource: "runtimeclasses"},
	"validatingwebhookconfigurations": {Group: "admissionregistration.k8s.io", Version: "v1", Resource: "validatingwebhookconfigurations"},
	"mutatingwebhookconfigurations":   {Group: "admissionregistration.k8s.io", Version: "v1", Resource: "mutatingwebhookconfigurations"},
	"leases":                          {Group: "coordination.k8s.io", Version: "v1", Resource: "leases"},
	"limitranges":                     {Group: "", Version: "v1", Resource: "limitranges"},
	"resourcequotas":                  {Group: "", Version: "v1", Resource: "resourcequotas"},
	"poddisruptionbudgets":            {Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"},
	"customresourcedefinitions":       {Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"},
}

func resourceToGVR(resource string) (schema.GroupVersionResource, bool) {
	gvr, ok := watchKinds[resource]
	return gvr, ok
}

// customResourceGVR reads a path that names its own group, version and plural (/apis/<group>/<version>[/namespaces/<ns>]/<plural>).
// A CRD's group always has a dot.
func customResourceGVR(path string) (schema.GroupVersionResource, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 4 || parts[0] != "apis" || !strings.Contains(parts[1], ".") {
		return schema.GroupVersionResource{}, false
	}
	switch {
	case len(parts) == 4:
		return schema.GroupVersionResource{Group: parts[1], Version: parts[2], Resource: parts[3]}, true
	case len(parts) == 6 && parts[3] == "namespaces":
		return schema.GroupVersionResource{Group: parts[1], Version: parts[2], Resource: parts[5]}, true
	}
	return schema.GroupVersionResource{}, false
}

// watchTarget is what a REQUEST's path reaches. A watch of changes may name any custom resource, since its frames hold no
// object; one that sends objects stays with watchKinds, whose rows the list screens are written for.
func watchTarget(path string, notify bool) (schema.GroupVersionResource, bool) {
	resource, _, err := parsePath(path)
	if err != nil {
		return schema.GroupVersionResource{}, false
	}
	known, ok := resourceToGVR(resource)
	if !notify {
		return known, ok
	}
	if custom, isCustom := customResourceGVR(path); isCustom && (!ok || custom.Group != known.Group) {
		return custom, true
	}
	return known, ok
}

func isNotifyQuery(query string) bool {
	return parseQuery(query)[notifyParam] == "1"
}

// ProtectedResolver, which the k8s Service implements, names the guarded namespaces on the cluster in ctx.
type ProtectedResolver interface {
	ProtectedNamespaces(ctx context.Context) protectedns.Namespaces
}

// protectedRefusal applies the guarded namespaces to a watch that names a namespace, once and in words. A watch of
// every namespace has its Secrets narrowed by the cluster client. "" = allowed.
func (m *Multiplexer) protectedRefusal(ctx context.Context, payload auth.TokenPayload, clusterID, path string) string {
	r, ok := m.provider.(ProtectedResolver)
	if !ok {
		return ""
	}
	resource, namespace, err := parsePath(path)
	if err != nil {
		return ""
	}
	gvr, ok := resourceToGVR(resource)
	if !ok {
		return ""
	}
	rules := r.ProtectedNamespaces(cluster.WithID(ctx, cluster.ID(clusterID)))
	if err := rules.Refusal(payload, clusterID, namespace, protectedns.ActOf(gvr.Group, "watch", gvr.Resource, "")); err != nil {
		return err.Error()
	}
	return ""
}

// namespaceScopeRefusal applies a namespace-scoped grant to a watch: the path
// must name one of the granted namespaces (an all-namespaces watch is refused;
// the client subscribes per namespace instead), or a kind of the cluster whose
// list route leaves it to the cluster's RBAC, asked in clusterListRefusal. "" = allowed.
func namespaceScopeRefusal(payload auth.TokenPayload, clusterID, path string) string {
	return namespaceScopeRefusalOf(payload, clusterID, path, "")
}

func namespaceScopeRefusalOf(payload auth.TokenPayload, clusterID, path, query string) string {
	scope := payload.Namespaces[clusterID]
	if len(scope) == 0 {
		return ""
	}
	resource, namespace, err := parsePath(path)
	if err != nil {
		return ""
	}
	if namespace == "" {
		if leftToTheClustersRBAC(path, query) {
			return ""
		}
		if clusterWideWatch[resource] {
			return objectsOfTheClusterRefusal(payload, clusterID, resource)
		}
		return "forbidden: your grant on cluster " + clusterID + " is limited to namespaces " + strings.Join(scope, ", ") + "; watch one of them"
	}
	if !payload.AllowedIn(clusterID, namespace) {
		return "forbidden: namespace " + namespace + " is outside your grant on cluster " + clusterID + " (" + strings.Join(scope, ", ") + ")"
	}
	if clusterWideWatch[resource] {
		return objectsOfTheClusterRefusal(payload, clusterID, resource)
	}
	return ""
}

func objectsOfTheClusterRefusal(payload auth.TokenPayload, clusterID, resource string) string {
	return "forbidden: " + resource + " are objects of the cluster, outside your grant on cluster " + clusterID + " (" + strings.Join(payload.Namespaces[clusterID], ", ") + ")"
}

// leftToTheClustersRBAC holds a watch across namespaces that a grant limited to them may ask the cluster for: a kind of
// the cluster, as its list route (scopeClusterObject), or a custom resource whose frames hold no object. The Namespaces
// list is narrowed to the grant and a watch of them would tell of the others.
func leftToTheClustersRBAC(path, query string) bool {
	resource, _, err := parsePath(path)
	if err != nil {
		return false
	}
	if resource == "namespaces" {
		return false
	}
	if clusterWideWatch[resource] {
		return true
	}
	if !isNotifyQuery(query) {
		return false
	}
	_, isCustom := customResourceGVR(path)
	return isCustom
}

// ListChecker, which the k8s Service implements, asks the cluster whether the caller in ctx may list a kind everywhere.
type ListChecker interface {
	MayListKind(ctx context.Context, group, resource string) (bool, error)
}

// clusterListRefusal is what stands between a grant limited to namespaces and a watch across them (leftToTheClustersRBAC):
// the cluster's refusal, said once, with no place held and no watch going back to the API server every five seconds.
// A question that fails is no refusal: the watch then says what is wrong with the cluster. "" = go on.
func (m *Multiplexer) clusterListRefusal(ctx context.Context, payload auth.TokenPayload, clusterID string, req RequestMessage) string {
	if len(payload.Namespaces[clusterID]) == 0 {
		return ""
	}
	resource, namespace, err := parsePath(req.Path)
	if err != nil || namespace != "" {
		return ""
	}
	gvr, ok := watchTarget(req.Path, isNotifyQuery(req.Query))
	if !ok {
		return ""
	}
	checker, ok := m.provider.(ListChecker)
	if !ok {
		return objectsOfTheClusterRefusal(payload, clusterID, resource)
	}
	allowed, err := checker.MayListKind(ctx, gvr.Group, gvr.Resource)
	if err != nil || allowed {
		return ""
	}
	return objectsOfTheClusterRefusal(payload, clusterID, resource)
}

// namespaceScopeReason tells the screen a kind of the cluster from a refusal: the limit of the grant is why its rows do
// not follow, and no role or cluster setting changes that.
func namespaceScopeReason(path string) string {
	if resource, _, err := parsePath(path); err == nil && clusterWideWatch[resource] {
		return reasonScope
	}
	return reasonForbidden
}

// clusterWideWatch holds kinds no namespace has. A page of a grant limited to namespaces asks for them once per namespace
// (scopedPaths), which the cluster would refuse every five seconds, each holding a place in the tab's limit of watches.
// TestEveryKindWithNoNamespaceIsRefusedToAGrantLimitedToNamespaces holds it to watchKinds.
var clusterWideWatch = map[string]bool{
	"clusterroles":                    true,
	"clusterrolebindings":             true,
	"priorityclasses":                 true,
	"runtimeclasses":                  true,
	"validatingwebhookconfigurations": true,
	"mutatingwebhookconfigurations":   true,
	"customresourcedefinitions":       true,
	"nodes":                           true,
	"namespaces":                      true,
	"persistentvolumes":               true,
	"pvs":                             true,
	"ingressclasses":                  true,
	"storageclasses":                  true,
	"volumeattachments":               true,
	"gatewayclasses":                  true,
	"deviceclasses":                   true,
	"resourceslices":                  true,
}
