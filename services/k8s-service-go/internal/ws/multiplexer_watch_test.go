package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type fakeClients struct{ d dynamic.Interface }

func (p fakeClients) Clientset() *kubernetes.Clientset                { return nil }
func (p fakeClients) Dynamic() dynamic.Interface                      { return p.d }
func (p fakeClients) DynamicForCtx(context.Context) dynamic.Interface { return p.d }

const (
	podEvent     = `{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-1","namespace":"demo","resourceVersion":"10"},"spec":{"containers":[]},"status":{"phase":"Running"}}}`
	expiredEvent = `{"type":"ERROR","object":{"apiVersion":"v1","kind":"Status","status":"Failure","message":"too old resource version: 10","reason":"Expired","code":410}}`
	goneStatus   = `{"apiVersion":"v1","kind":"Status","status":"Failure","message":"too old resource version: 10","reason":"Expired","code":410}`
	bookmark     = `{"type":"BOOKMARK","object":{"apiVersion":"v1","kind":"Pod","metadata":{"resourceVersion":"77"}}}`
)

// muxOn is a multiplexer whose clients talk to a fake API server.
func muxOn(t *testing.T, api http.HandlerFunc) *Multiplexer {
	t.Helper()
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	d, err := dynamic.NewForConfig(&rest.Config{Host: server.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	return NewMultiplexer(fakeClients{d})
}

// eventThenHold sends one pod event and keeps the watch open, as a quiet cluster does.
func eventThenHold(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, podEvent)
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

// frame is a message as a browser reads it.
type frame struct {
	Type      string `json:"type"`
	ClusterID string `json:"clusterId"`
	Path      string `json:"path"`
	Query     string `json:"query"`
	Data      struct {
		Type   string         `json:"type"`
		Object map[string]any `json:"object"`
	} `json:"data"`
	Error struct {
		Message string `json:"message"`
		Reason  string `json:"reason"`
	} `json:"error"`
}

// socketTo opens a tab's socket on m as a caller with these permissions.
func socketTo(t *testing.T, m *Multiplexer, perms auth.PermissionMatrix) *websocket.Conn {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{Perms: perms})))
	}))
	t.Cleanup(server.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	return conn
}

var everyCluster = auth.PermissionMatrix{"*": {"*"}}

func request(t *testing.T, conn *websocket.Conn, kind, cluster, path, query string) {
	t.Helper()
	if err := conn.WriteJSON(RequestMessage{Type: kind, ClusterID: cluster, Path: path, Query: query}); err != nil {
		t.Fatal(err)
	}
}

func nextFrame(t *testing.T, conn *websocket.Conn) frame {
	t.Helper()
	var f frame
	if err := conn.ReadJSON(&f); err != nil {
		t.Fatalf("no frame: %v", err)
	}
	return f
}

func waitForSubscriptions(t *testing.T, m *Multiplexer, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m.SubscriptionCount() == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("live subscriptions = %d, want %d", m.SubscriptionCount(), want)
}

func TestClosedWatchesLeaveTheTabsLimitFree(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	for i := 1; i <= defaultMaxSubscriptionsPerConn+10; i++ {
		request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
		if f := nextFrame(t, conn); f.Type != "DATA" {
			t.Fatalf("watch %d after the earlier ones closed: got %s %q, want DATA", i, f.Type, f.Error.Message)
		}
		request(t, conn, "CLOSE", "default", "/api/v1/pods", "watch=1")
		waitForSubscriptions(t, m, 0)
	}
}

func TestOpenWatchesStopAtTheTabsLimitUntilOneCloses(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	query := func(i int) string { return fmt.Sprintf("watch=1&labelSelector=n%%3D%d", i) }
	for i := 0; i < defaultMaxSubscriptionsPerConn; i++ {
		request(t, conn, "REQUEST", "default", "/api/v1/pods", query(i))
		if f := nextFrame(t, conn); f.Type != "DATA" {
			t.Fatalf("watch %d inside the limit: got %s %q", i+1, f.Type, f.Error.Message)
		}
	}
	waitForSubscriptions(t, m, defaultMaxSubscriptionsPerConn)

	request(t, conn, "REQUEST", "default", "/api/v1/pods", query(100))
	f := nextFrame(t, conn)
	want := fmt.Sprintf("max subscriptions reached for this connection (%d), cannot create new watch", defaultMaxSubscriptionsPerConn)
	if f.Type != "ERROR" || f.Error.Message != want {
		t.Fatalf("watch past the limit: got %s %q, want ERROR %q", f.Type, f.Error.Message, want)
	}
	waitForSubscriptions(t, m, defaultMaxSubscriptionsPerConn)

	request(t, conn, "CLOSE", "default", "/api/v1/pods", query(0))
	waitForSubscriptions(t, m, defaultMaxSubscriptionsPerConn-1)
	request(t, conn, "REQUEST", "default", "/api/v1/pods", query(100))
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("watch after one closed: got %s %q, want DATA", f.Type, f.Error.Message)
	}
}

func TestOpenWatchesStopAtTheServersLimitUntilOneCloses(t *testing.T) {
	m := muxOn(t, eventThenHold)
	m.MaxSubscriptions = 1
	first := socketTo(t, m, everyCluster)
	second := socketTo(t, m, everyCluster)

	request(t, first, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, first); f.Type != "DATA" {
		t.Fatalf("watch inside the limit: got %s %q", f.Type, f.Error.Message)
	}
	request(t, second, "REQUEST", "default", "/api/v1/pods", "watch=1")
	f := nextFrame(t, second)
	if want := "max subscriptions reached for the server (1), cannot create new watch"; f.Type != "ERROR" || f.Error.Message != want {
		t.Fatalf("watch past the limit: got %s %q, want ERROR %q", f.Type, f.Error.Message, want)
	}

	request(t, first, "CLOSE", "default", "/api/v1/pods", "watch=1")
	waitForSubscriptions(t, m, 0)
	request(t, second, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, second); f.Type != "DATA" {
		t.Fatalf("watch after one closed: got %s %q, want DATA", f.Type, f.Error.Message)
	}
}

// The closed watch ends a moment after the same one is asked for again, and that must not free the new one's place.
func TestReopenedWatchKeepsItsPlaceWhenTheClosedOneEnds(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	for i := 1; i <= 20; i++ {
		request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
		if f := nextFrame(t, conn); f.Type != "DATA" {
			t.Fatalf("round %d: got %s %q, want DATA", i, f.Type, f.Error.Message)
		}
		request(t, conn, "CLOSE", "default", "/api/v1/pods", "watch=1")
	}
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("last watch: got %s %q, want DATA", f.Type, f.Error.Message)
	}
	time.Sleep(200 * time.Millisecond)
	if got := m.SubscriptionCount(); got != 1 {
		t.Errorf("live subscriptions = %d, want the reopened one", got)
	}
}

// A watch that cannot start names the reason every time it is asked for, and holds no place meanwhile.
func TestWatchThatEndsByItselfGivesItsPlaceBack(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	for i := 1; i <= 2; i++ {
		request(t, conn, "REQUEST", "default", "/api/v1/widgets", "watch=1")
		if f := nextFrame(t, conn); f.Type != "ERROR" || f.Error.Message != "unsupported resource: widgets" {
			t.Fatalf("request %d: got %s %q", i, f.Type, f.Error.Message)
		}
		waitForSubscriptions(t, m, 0)
	}
}

// versionsAsked records the resourceVersion of every watch the API server is asked for.
type versionsAsked chan string

func (v versionsAsked) next(t *testing.T) string {
	t.Helper()
	select {
	case rv := <-v:
		return rv
	case <-time.After(8 * time.Second):
		t.Fatal("the watch was not asked for again")
		return ""
	}
}

// The two ways the API server says a version has expired; the watch after them, asked with no version, holds.
var expiryCases = []struct {
	name  string
	serve func(w http.ResponseWriter, call int)
	// the versions asked for, the last with none
	want []string
}{
	{"in the watch stream", func(w http.ResponseWriter, _ int) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, podEvent)
		fmt.Fprintln(w, expiredEvent)
	}, []string{"", ""}},
	{"as the answer to resuming", func(w http.ResponseWriter, call int) {
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			fmt.Fprintln(w, podEvent)
			return
		}
		w.WriteHeader(http.StatusGone)
		fmt.Fprintln(w, goneStatus)
	}, []string{"", "10", ""}},
}

func TestExpiredResourceVersionIsNotAskedForAgain(t *testing.T) {
	for _, c := range expiryCases {
		t.Run(c.name, func(t *testing.T) {
			asked := make(versionsAsked, 10)
			var calls atomic.Int32
			m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1))
				asked <- r.URL.Query().Get("resourceVersion")
				if n < len(c.want) {
					c.serve(w, n)
					return
				}
				eventThenHold(w, r)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			out := make(chan ResponseMessage, 100)
			done := make(chan struct{})
			go func() { defer close(done); watchInto(ctx, m, "/api/v1/pods", "watch=1", out) }()

			got := []string{}
			for range c.want {
				got = append(got, asked.next(t))
			}
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Errorf("versions asked for = %q, want %q", got, c.want)
			}
			cancel()
			waitEnded(t, done, 10*time.Second)
		})
	}
}

// A watch from no version sends the objects there are but not those deleted meanwhile, so the client has to read its
// list again: exactly one RESYNC, no error, and only once the new watch is on, so that a delete after that read still
// arrives as an event.
func TestExpiredResourceVersionAsksTheClientToReadTheListAgain(t *testing.T) {
	for _, c := range expiryCases {
		t.Run(c.name, func(t *testing.T) {
			var calls atomic.Int32
			m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1))
				if n < len(c.want) {
					c.serve(w, n)
					return
				}
				eventThenHold(w, r)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			out := make(chan ResponseMessage, 100)
			done := make(chan struct{})
			go func() { defer close(done); watchInto(ctx, m, "/api/v1/pods", "watch=1", out) }()

			got := []string{}
			for len(got) < 3 {
				select {
				case f := <-out:
					if f.Path != "/api/v1/pods" || f.Query != "watch=1" {
						t.Errorf("frame %s for %s?%s", f.Type, f.Path, f.Query)
					}
					if f.Type == "RESYNC" {
						if on := int(calls.Load()); on != len(c.want) {
							t.Errorf("RESYNC after %d watches were asked for, want %d", on, len(c.want))
						}
					}
					got = append(got, f.Type)
				case <-time.After(8 * time.Second):
					t.Fatalf("frames so far = %q, want [DATA RESYNC DATA]", got)
				}
			}
			if want := []string{"DATA", "RESYNC", "DATA"}; fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("frames = %q, want %q", got, want)
			}
			cancel()
			waitEnded(t, done, 10*time.Second)
		})
	}
}

func TestBookmarkMovesTheResumePointAndStaysOnTheServer(t *testing.T) {
	asked := make(versionsAsked, 10)
	bookmarks := make(chan string, 10)
	var calls atomic.Int32
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		asked <- r.URL.Query().Get("resourceVersion")
		bookmarks <- r.URL.Query().Get("allowWatchBookmarks")
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			fmt.Fprintln(w, bookmark)
			return
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan ResponseMessage, 100)
	done := make(chan struct{})
	go func() { defer close(done); watchInto(ctx, m, "/api/v1/pods", "watch=1", out) }()

	asked.next(t)
	if got := <-bookmarks; got != "true" {
		t.Errorf("allowWatchBookmarks = %q, want true", got)
	}
	if got := asked.next(t); got != "77" {
		t.Errorf("resumed from version %q, want the bookmark's 77", got)
	}
	cancel()
	waitEnded(t, done, 10*time.Second)
	if len(out) != 0 {
		t.Errorf("frames sent to the client = %d, want none: %+v", len(out), <-out)
	}
}

func waitEnded(t *testing.T, done <-chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("the watch is still running %s after it was canceled", within)
	}
}

func TestCanceledWatchEndsWithItsSendQueueFull(t *testing.T) {
	eventServed := make(chan struct{}, 1)
	cases := []struct {
		name string
		path string
		api  http.HandlerFunc
		// when the watch is known to be waiting on the queue
		sending <-chan struct{}
	}{
		{"holding an event", "/api/v1/pods", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintln(w, podEvent)
			w.(http.Flusher).Flush()
			eventServed <- struct{}{}
			<-r.Context().Done()
		}, eventServed},
		{"holding the error of a failed watch", "/api/v1/pods", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}, nil},
		{"holding the error of a path it cannot watch", "/api/v1/widgets", eventThenHold, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := muxOn(t, c.api)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			out := make(chan ResponseMessage, 256)
			for len(out) < cap(out) {
				out <- ResponseMessage{Type: "ALREADY-QUEUED"}
			}
			done := make(chan struct{})
			go func() { defer close(done); watchInto(ctx, m, c.path, "watch=1", out) }()
			if c.sending != nil {
				<-c.sending
			}
			time.Sleep(200 * time.Millisecond)
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				for len(out) > 0 {
					<-out // lets the watch end, so the test leaves nothing behind
				}
				t.Fatal("the watch is still running 2s after it was canceled")
			}
		})
	}
}

// Waiting to try again is not a reason to outlive the client.
func TestCanceledWatchDoesNotWaitOutItsRetryDelay(t *testing.T) {
	failed := make(chan struct{}, 10)
	m := muxOn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		failed <- struct{}{}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan ResponseMessage, 256)
	done := make(chan struct{})
	go func() { defer close(done); watchInto(ctx, m, "/api/v1/pods", "watch=1", out) }()
	<-failed
	if f := <-out; f.Type != "ERROR" {
		t.Fatalf("frame = %s, want ERROR", f.Type)
	}
	cancel()
	started := time.Now()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch did not end")
	}
	if waited := time.Since(started); waited > time.Second {
		t.Errorf("the watch ended %s after it was canceled, want at once", waited.Round(time.Millisecond))
	}
}

// A tab that went away while its queue was full: with the writer gone nothing drains the queue, so the handler that
// waits on it has to learn of it, or it and the tab's watches stay for good.
func TestConnectionEndsWhenTheClientGoesAwayWithItsQueueFull(t *testing.T) {
	m := muxOn(t, eventThenHold)
	ended := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(ended)
		// no permissions: each request is answered with an error that repeats its path
		m.HandleWebSocket(w, r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{})))
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	longPath := "/api/v1/" + strings.Repeat("x", 50*1024)
	sent := 0
	for ; sent < 5000; sent++ {
		_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
		if err := conn.WriteJSON(RequestMessage{Type: "REQUEST", ClusterID: "default", Path: longPath, Query: "watch=1"}); err != nil {
			break // the server stopped reading: its queue is full
		}
	}
	if sent == 5000 {
		t.Fatal("the server never stopped reading; the queue did not fill")
	}
	_ = conn.Close()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatalf("the connection's handler is still running 5s after the client went away (%d requests sent)", sent)
	}
}

func TestFramesNameTheClusterTheirRequestNamed(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, auth.PermissionMatrix{"cluster-a": {"resource.*.read"}, "cluster-b": {"resource.*.read"}})
	byCluster := func(want int) map[string]frame {
		t.Helper()
		got := map[string]frame{}
		for range want {
			f := nextFrame(t, conn)
			got[f.ClusterID] = f
		}
		return got
	}

	// the same path and query on two clusters
	request(t, conn, "REQUEST", "cluster-a", "/api/v1/pods", "watch=1")
	request(t, conn, "REQUEST", "cluster-b", "/api/v1/pods", "watch=1")
	frames := byCluster(2)
	for _, cluster := range []string{"cluster-a", "cluster-b"} {
		f, ok := frames[cluster]
		if !ok {
			t.Fatalf("no frame names %s: %+v", cluster, frames)
		}
		// what a screen before clusterId reads stays where it was
		if f.Type != "DATA" || f.Path != "/api/v1/pods" || f.Query != "watch=1" || f.Data.Type != "ADDED" || f.Data.Object["name"] != "web-1" {
			t.Errorf("%s: frame = %+v", cluster, f)
		}
	}

	// a watch that cannot start, and a cluster the caller may not read
	request(t, conn, "REQUEST", "cluster-a", "/api/v1/widgets", "watch=1")
	if f := nextFrame(t, conn); f.Type != "ERROR" || f.ClusterID != "cluster-a" {
		t.Errorf("unsupported resource: frame = %+v", f)
	}
	request(t, conn, "REQUEST", "cluster-c", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "ERROR" || f.ClusterID != "cluster-c" {
		t.Errorf("no access: frame = %+v", f)
	}
}

// A REQUEST naming no cluster gets frames naming none, so the client finds its subscription by what it sent.
func TestFramesNameNoClusterWhenTheRequestNamedNone(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "", "/api/v1/pods", "watch=1")
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]any
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f["type"] != "DATA" {
		t.Fatalf("frame = %s", raw)
	}
	if _, named := f["clusterId"]; named {
		t.Errorf("frame names a cluster: %s", raw)
	}
}

// watchInto runs a watch of the default cluster as the multiplexer does.
func watchInto(ctx context.Context, m *Multiplexer, path, query string, out chan<- ResponseMessage) {
	m.runWatch(ctx, RequestMessage{Path: path, Query: query}, out)
}

// protectedClients answers like the k8s Service, which names the guarded namespaces on the cluster in ctx.
type protectedClients struct {
	fakeClients
	rules protectedns.Namespaces
}

func (p protectedClients) ProtectedNamespaces(context.Context) protectedns.Namespaces { return p.rules }

// A watch of a guarded namespace's Secrets is refused once, in words, instead of failing every few seconds at the cluster.
func TestAWatchOfTheInstallNamespacesSecretsIsRefusedOnce(t *testing.T) {
	var asked atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		eventThenHold(w, r)
	}))
	t.Cleanup(server.Close)
	d, err := dynamic.NewForConfig(&rest.Config{Host: server.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	rules := protectedns.Namespaces{Install: "kubeast", NodeShell: "kubeast-node-shell"}
	m := NewMultiplexer(protectedClients{fakeClients{d}, rules})
	write := auth.PermissionMatrix{"c": {"resource.*.read", "resource.secret.reveal"}}

	conn := socketTo(t, m, write)
	request(t, conn, "REQUEST", "c", "/api/v1/namespaces/kubeast/secrets", "watch=1")
	if f := nextFrame(t, conn); f.Type != "ERROR" || !strings.Contains(f.Error.Message, "kubeast") {
		t.Fatalf("got %s %q, want the refusal", f.Type, f.Error.Message)
	}
	if asked.Load() != 0 || m.SubscriptionCount() != 0 {
		t.Fatalf("the cluster was asked %d times, %d subscriptions", asked.Load(), m.SubscriptionCount())
	}

	// other kinds there, and Secrets elsewhere, watch as before
	for _, path := range []string{"/api/v1/namespaces/kubeast/pods", "/api/v1/namespaces/shop/secrets"} {
		request(t, conn, "REQUEST", "c", path, "watch=1")
		if f := nextFrame(t, conn); f.Type != "DATA" {
			t.Fatalf("%s: got %s %q", path, f.Type, f.Error.Message)
		}
	}

	// a global admin keeps it
	admin := socketTo(t, m, everyCluster)
	request(t, admin, "REQUEST", "c", "/api/v1/namespaces/kubeast/secrets", "watch=1")
	if f := nextFrame(t, admin); f.Type != "DATA" {
		t.Fatalf("global admin: got %s %q", f.Type, f.Error.Message)
	}
}
