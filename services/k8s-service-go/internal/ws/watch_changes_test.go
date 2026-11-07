package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/dynamic"
)

const changesQuery = "watch=1&notify=1"

// changesAPI is a stand-in API server: a list answers the resource version it holds and no item, a watch records what it
// was asked and sends the lines it is given until the client goes.
type changesAPI struct {
	mu      sync.Mutex
	rv      string
	refuse  int
	lists   []string
	watches []string
	lines   chan string
}

func newChangesAPI() *changesAPI { return &changesAPI{rv: "100", lines: make(chan string, 256)} }

func (a *changesAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := r.URL.Query()
	asked := r.URL.Path
	if s := q.Get("fieldSelector"); s != "" {
		asked += " field=" + s
	}
	if q.Get("watch") != "true" {
		a.mu.Lock()
		a.lists = append(a.lists, asked+" limit="+q.Get("limit"))
		refuse, rv := a.refuse, a.rv
		a.mu.Unlock()
		if refuse != 0 {
			w.WriteHeader(refuse)
			fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","code":%d,"message":"refused"}`, refuse)
			return
		}
		fmt.Fprintf(w, `{"apiVersion":"v1","kind":"List","metadata":{"resourceVersion":%q},"items":[]}`, rv)
		return
	}
	a.mu.Lock()
	a.watches = append(a.watches, asked+" from="+q.Get("resourceVersion"))
	a.mu.Unlock()
	w.(http.Flusher).Flush()
	for {
		select {
		case line := <-a.lines:
			fmt.Fprintln(w, line)
			w.(http.Flusher).Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (a *changesAPI) asked() (lists, watches []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.lists...), append([]string(nil), a.watches...)
}

func (a *changesAPI) waitForWatches(t *testing.T, want int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, watches := a.asked(); len(watches) >= want {
			return watches
		}
		time.Sleep(time.Millisecond)
	}
	_, watches := a.asked()
	t.Fatalf("the API server was asked for %v, want %d watches", watches, want)
	return nil
}

func objectEvent(name, rv string) string {
	return fmt.Sprintf(`{"type":"MODIFIED","object":{"apiVersion":"example.com/v1","kind":"Widget","metadata":{"name":%q,"namespace":"team-a","resourceVersion":%q},"spec":{"secretish":"value-of-the-object"}}}`, name, rv)
}

// framesOf reads the socket's frames onto a channel: a read that runs into its deadline leaves a websocket unusable, so
// a test that waits for nothing to come waits here instead.
func framesOf(conn *websocket.Conn) <-chan frame {
	out := make(chan frame, 1024)
	go func() {
		defer close(out)
		for {
			var f frame
			if err := conn.ReadJSON(&f); err != nil {
				return
			}
			out <- f
		}
	}()
	return out
}

// framesUntilQuiet takes what comes until nothing has come for quiet.
func framesUntilQuiet(frames <-chan frame, quiet time.Duration) []frame {
	got := []frame{}
	for {
		select {
		case f, open := <-frames:
			if !open {
				return got
			}
			got = append(got, f)
		case <-time.After(quiet):
			return got
		}
	}
}

func nextOf(t *testing.T, frames <-chan frame) frame {
	t.Helper()
	select {
	case f, open := <-frames:
		if !open {
			t.Fatal("the socket closed")
		}
		return f
	case <-time.After(10 * time.Second):
		t.Fatal("no frame")
	}
	return frame{}
}

// A table that has to be read again anyway needs to hear that something changed, not every object it has: a kind of
// 50 000 objects would send them all as a watch opens, for nobody to read.
func TestAWatchOfChangesStartsFromNowAndSendsNoObject(t *testing.T) {
	api := newChangesAPI()
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	const path = "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"
	request(t, conn, "REQUEST", "c1", path, changesQuery)
	watches := api.waitForWatches(t, 1)
	lists, _ := api.asked()
	if want := path + " limit=1"; len(lists) != 1 || lists[0] != want {
		t.Errorf("reads before the watch: %v, want only %q", lists, want)
	}
	if want := path + " from=100"; watches[0] != want {
		t.Errorf("watch = %q, want %q: one with no version sends every object as it opens", watches[0], want)
	}

	api.lines <- objectEvent("a", "101")
	f := nextFrame(t, conn)
	if f.Type != "CHANGED" {
		t.Fatalf("frame %s, want CHANGED", f.Type)
	}
	if f.Data.Object != nil || f.Data.Type != "" {
		t.Errorf("the frame carries the object: %+v", f.Data)
	}
	if f.Path != path || f.Query != changesQuery || f.ClusterID != "c1" {
		t.Errorf("the frame does not name its request: %+v", f)
	}
}

// However fast the objects change the client hears of it about once a second, and the last change is told too.
func TestAWatchOfChangesTellsOfABurstOnceASecond(t *testing.T) {
	api := newChangesAPI()
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/rbac.authorization.k8s.io/v1/clusterroles", changesQuery)
	api.waitForWatches(t, 1)
	incoming := framesOf(conn)

	for i := 0; i < 200; i++ {
		api.lines <- objectEvent(fmt.Sprintf("w-%d", i), fmt.Sprint(200+i))
	}
	frames := framesUntilQuiet(incoming, 2500*time.Millisecond)
	if len(frames) == 0 || len(frames) > 2 {
		t.Fatalf("200 changes at once told %d times, want 1 or 2", len(frames))
	}
	for _, f := range frames {
		if f.Type != "CHANGED" {
			t.Errorf("frame %s", f.Type)
		}
	}

	api.lines <- objectEvent("later", "999")
	if f := nextOf(t, incoming); f.Type != "CHANGED" {
		t.Errorf("a change after a quiet moment: frame %s", f.Type)
	}
}

func TestAWatchOfChangesReachesACustomResource(t *testing.T) {
	for _, c := range []struct{ path, reaches string }{
		{"/apis/widgets.example.com/v1/widgets", "/apis/widgets.example.com/v1/widgets"},
		{"/apis/widgets.example.com/v1beta2/namespaces/team-a/widgets", "/apis/widgets.example.com/v1beta2/namespaces/team-a/widgets"},
		// a plural a built-in kind uses too: the path's group decides, not the name
		{"/apis/networking.istio.io/v1/namespaces/team-a/gateways", "/apis/networking.istio.io/v1/namespaces/team-a/gateways"},
	} {
		t.Run(c.path, func(t *testing.T) {
			api := newChangesAPI()
			m := muxOn(t, api.serve)
			conn := socketTo(t, m, everyCluster)
			request(t, conn, "REQUEST", "c1", c.path, changesQuery)
			if watches := api.waitForWatches(t, 1); watches[0] != c.reaches+" from=100" {
				t.Errorf("watch = %q, want %q", watches[0], c.reaches)
			}
			api.lines <- objectEvent("w", "101")
			if f := nextFrame(t, conn); f.Type != "CHANGED" {
				t.Errorf("frame %s %q", f.Type, f.Error.Message)
			}
		})
	}
}

// Without an object in the frame the path may name any custom resource. Frames of objects stay with the kinds the list
// rows are written for, and a path that names no group of a custom resource goes nowhere.
func TestACustomResourceIsOnlyWatchedForItsChanges(t *testing.T) {
	for _, c := range []struct{ path, query string }{
		{"/apis/widgets.example.com/v1/widgets", "watch=1"},
		{"/apis/nodots/v1/widgets", changesQuery},
		{"/apis/widgets.example.com/widgets", changesQuery},
	} {
		t.Run(c.path+"?"+c.query, func(t *testing.T) {
			api := newChangesAPI()
			m := muxOn(t, api.serve)
			conn := socketTo(t, m, everyCluster)
			request(t, conn, "REQUEST", "c1", c.path, c.query)
			f := nextFrame(t, conn)
			if f.Type != "ERROR" || f.Error.Reason != reasonUnsupported {
				t.Fatalf("frame %s reason %q, want a refusal as unsupported", f.Type, f.Error.Reason)
			}
			waitForSubscriptions(t, m, 0)
			if lists, watches := api.asked(); len(lists)+len(watches) != 0 {
				t.Errorf("the API server was asked for %v %v", lists, watches)
			}
		})
	}
}

// The one object or the node's pods stay what is watched; the version comes from the cheapest read there is.
func TestAWatchOfChangesKeepsItsSelectorOffTheReadOfTheVersion(t *testing.T) {
	api := newChangesAPI()
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/widgets.example.com/v1/namespaces/team-a/widgets", changesQuery+"&fieldSelector=metadata.name%3Done")
	watches := api.waitForWatches(t, 1)
	lists, _ := api.asked()
	if want := "/apis/widgets.example.com/v1/namespaces/team-a/widgets limit=1"; len(lists) != 1 || lists[0] != want {
		t.Errorf("read before the watch: %v, want %q", lists, want)
	}
	if want := "/apis/widgets.example.com/v1/namespaces/team-a/widgets field=metadata.name=one from=100"; watches[0] != want {
		t.Errorf("watch = %q, want %q", watches[0], want)
	}
}

func TestAWatchOfChangesTheClusterRefusesSaysSoAndKeepsItsPlace(t *testing.T) {
	api := newChangesAPI()
	api.refuse = http.StatusForbidden
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/rbac.authorization.k8s.io/v1/clusterroles", changesQuery)
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || f.Error.Reason != reasonForbidden {
		t.Fatalf("frame %s reason %q, want the cluster's refusal", f.Type, f.Error.Reason)
	}
	waitForSubscriptions(t, m, 1)
	if _, watches := api.asked(); len(watches) != 0 {
		t.Errorf("watched after a refused read: %v", watches)
	}
}

// A version gone past the API server's window: nothing tells what changed since, so the client reads again.
func TestAWatchOfChangesWhoseVersionExpiredAsksForARead(t *testing.T) {
	api := newChangesAPI()
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/rbac.authorization.k8s.io/v1/clusterroles", changesQuery)
	api.waitForWatches(t, 1)
	api.lines <- expiredEvent
	if f := nextFrame(t, conn); f.Type != "RESYNC" {
		t.Fatalf("frame %s, want RESYNC", f.Type)
	}
	if watches := api.waitForWatches(t, 2); watches[1] != "/apis/rbac.authorization.k8s.io/v1/clusterroles from=100" {
		t.Errorf("second watch = %q", watches[1])
	}
}

// A request that says the client missed something (it was refused a place, or a watch of changes lost its socket) gets
// one RESYNC once the watch is on, so what it reads again cannot miss what comes next.
func TestARequestThatMissedSomethingGetsOneResyncOnceTheWatchIsOn(t *testing.T) {
	api := newChangesAPI()
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	if err := conn.WriteJSON(map[string]any{"type": "REQUEST", "clusterId": "c1", "path": "/apis/rbac.authorization.k8s.io/v1/clusterroles", "query": changesQuery, "resync": true}); err != nil {
		t.Fatal(err)
	}
	incoming := framesOf(conn)
	f := nextOf(t, incoming)
	if f.Type != "RESYNC" {
		t.Fatalf("frame %s, want RESYNC", f.Type)
	}
	api.waitForWatches(t, 1)
	if rest := framesUntilQuiet(incoming, 300*time.Millisecond); len(rest) != 0 {
		t.Errorf("after the RESYNC: %+v", rest)
	}
}

// listAnswerClients answers whether the caller may list a kind as the cluster would.
type listAnswerClients struct {
	fakeClients
	mu    sync.Mutex
	allow bool
	err   error
	asked []string
}

func (p *listAnswerClients) MayListKind(_ context.Context, group, resource string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.asked = append(p.asked, group+"/"+resource)
	return p.allow, p.err
}

func scopedMuxOn(t *testing.T, api http.HandlerFunc, allow bool) (*Multiplexer, *listAnswerClients) {
	t.Helper()
	base := muxOn(t, api)
	clients := &listAnswerClients{fakeClients: base.provider.(fakeClients), allow: allow}
	return NewMultiplexer(clients), clients
}

// A list of a kind of the cluster answers a grant limited to namespaces by the cluster's RBAC, and its watch does the
// same: the watch reaches the API server when the cluster lets this caller list the kind.
func TestAKindOfTheClusterFollowsForAGrantLimitedToNamespacesWhenTheClusterLetsItList(t *testing.T) {
	for _, c := range []struct{ path, kind string }{
		{"/api/v1/nodes", "/nodes"},
		{"/api/v1/persistentvolumes", "/persistentvolumes"},
		{"/api/v1/pvs", "/persistentvolumes"},
		{"/api/v1/storageclasses", "storage.k8s.io/storageclasses"},
		{"/apis/storage.k8s.io/v1/volumeattachments", "storage.k8s.io/volumeattachments"},
		{"/apis/networking.k8s.io/v1/ingressclasses", "networking.k8s.io/ingressclasses"},
		{"/apis/rbac.authorization.k8s.io/v1/clusterroles", "rbac.authorization.k8s.io/clusterroles"},
		{"/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", "rbac.authorization.k8s.io/clusterrolebindings"},
		{"/apis/scheduling.k8s.io/v1/priorityclasses", "scheduling.k8s.io/priorityclasses"},
		{"/apis/node.k8s.io/v1/runtimeclasses", "node.k8s.io/runtimeclasses"},
		{"/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations", "admissionregistration.k8s.io/validatingwebhookconfigurations"},
		{"/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations", "admissionregistration.k8s.io/mutatingwebhookconfigurations"},
		{"/apis/apiextensions.k8s.io/v1/customresourcedefinitions", "apiextensions.k8s.io/customresourcedefinitions"},
		{"/apis/gateway.networking.k8s.io/v1/gatewayclasses", "gateway.networking.k8s.io/gatewayclasses"},
		{"/apis/resource.k8s.io/v1/deviceclasses", "resource.k8s.io/deviceclasses"},
		{"/apis/resource.k8s.io/v1/resourceslices", "resource.k8s.io/resourceslices"},
	} {
		t.Run(c.path, func(t *testing.T) {
			api := &apiSeen{object: watchEvent(t, nodeObjectForScopeTest)}
			m, clients := scopedMuxOn(t, api.serve, true)
			conn := socketAs(t, m, scopedToTeamA)
			request(t, conn, "REQUEST", "self", c.path, "watch=1")
			if f := nextFrame(t, conn); f.Type != "DATA" {
				t.Fatalf("frame %s %q, want the kind's frames", f.Type, f.Error.Message)
			}
			clients.mu.Lock()
			defer clients.mu.Unlock()
			if len(clients.asked) != 1 || clients.asked[0] != c.kind {
				t.Errorf("asked the cluster about %v, want %s", clients.asked, c.kind)
			}
		})
	}
}

const nodeObjectForScopeTest = `{"apiVersion":"v1","kind":"Node","metadata":{"name":"node-1","resourceVersion":"5"}}`

// Refused by the cluster: said once, no place in the tab's limit, and no watch going back to the API server every five
// seconds.
func TestAKindOfTheClusterTheClusterWillNotListIsRefusedOnceToAGrantLimitedToNamespaces(t *testing.T) {
	api := &apiSeen{object: watchEvent(t, nodeObjectForScopeTest)}
	m, _ := scopedMuxOn(t, api.serve, false)
	conn := socketAs(t, m, scopedToTeamA)
	request(t, conn, "REQUEST", "self", "/api/v1/nodes", "watch=1")
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || f.Error.Reason != reasonScope {
		t.Fatalf("frame %s reason %q, want the scope refusal", f.Type, f.Error.Reason)
	}
	waitForSubscriptions(t, m, 0)
	if asked := api.asked(); len(asked) != 0 {
		t.Errorf("the API server was asked for %v", asked)
	}
}

// A failed question is no refusal: the watch itself then says what is wrong with the cluster.
func TestAKindOfTheClusterWhoseListCouldNotBeAskedAboutGoesToTheCluster(t *testing.T) {
	api := &apiSeen{object: watchEvent(t, nodeObjectForScopeTest)}
	m, clients := scopedMuxOn(t, api.serve, false)
	clients.err = fmt.Errorf("the review could not be created")
	conn := socketAs(t, m, scopedToTeamA)
	request(t, conn, "REQUEST", "self", "/api/v1/nodes", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("frame %s %q", f.Type, f.Error.Message)
	}
}

// The list of namespaces is narrowed to the grant and a watch of them would tell of the others, whatever RBAC says.
func TestTheNamespacesStayRefusedToAGrantLimitedToNamespaces(t *testing.T) {
	api := &apiSeen{object: watchEvent(t, nodeObjectForScopeTest)}
	m, clients := scopedMuxOn(t, api.serve, true)
	conn := socketAs(t, m, scopedToTeamA)
	request(t, conn, "REQUEST", "self", "/api/v1/namespaces", "watch=1")
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || f.Error.Reason != reasonScope {
		t.Fatalf("frame %s reason %q", f.Type, f.Error.Reason)
	}
	waitForSubscriptions(t, m, 0)
	clients.mu.Lock()
	defer clients.mu.Unlock()
	if len(clients.asked) != 0 || len(api.asked()) != 0 {
		t.Errorf("asked %v and the API server %v", clients.asked, api.asked())
	}
}

// A custom resource of no namespace: its changes follow when the cluster lets the caller list it.
func TestACustomResourceOfTheClusterFollowsForAGrantLimitedToNamespaces(t *testing.T) {
	for _, allow := range []bool{true, false} {
		t.Run(fmt.Sprintf("the cluster answers %v", allow), func(t *testing.T) {
			api := newChangesAPI()
			m, clients := scopedMuxOn(t, api.serve, allow)
			conn := socketAs(t, m, scopedToTeamA)
			request(t, conn, "REQUEST", "self", "/apis/widgets.example.com/v1/gizmos", changesQuery)
			if allow {
				api.waitForWatches(t, 1)
				api.lines <- objectEvent("g", "101")
				if f := nextFrame(t, conn); f.Type != "CHANGED" {
					t.Fatalf("frame %s %q", f.Type, f.Error.Message)
				}
			} else {
				if f := nextFrame(t, conn); f.Type != "ERROR" || f.Error.Reason != reasonScope {
					t.Fatalf("frame %s reason %q", f.Type, f.Error.Reason)
				}
				waitForSubscriptions(t, m, 0)
			}
			clients.mu.Lock()
			defer clients.mu.Unlock()
			if len(clients.asked) != 1 || clients.asked[0] != "widgets.example.com/gizmos" {
				t.Errorf("asked %v", clients.asked)
			}
		})
	}
}

func readFrontendFile(name string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(frontendSources, name))
	return string(raw), err
}

// A custom resource in a namespace outside the grant stays outside it, changes or not.
func TestACustomResourceInANamespaceOutsideTheGrantIsRefused(t *testing.T) {
	api := newChangesAPI()
	m, _ := scopedMuxOn(t, api.serve, false)
	conn := socketAs(t, m, scopedToTeamA)
	request(t, conn, "REQUEST", "self", "/apis/widgets.example.com/v1/namespaces/team-b/widgets", changesQuery)
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || !strings.Contains(f.Error.Message, "outside your grant") {
		t.Fatalf("frame %s %q, want the namespace refused", f.Type, f.Error.Message)
	}
}

type lateClients struct {
	fakeClients
	ready atomic.Bool
}

func (p *lateClients) DynamicForCtx(context.Context) dynamic.Interface {
	if !p.ready.Load() {
		return nil
	}
	return p.d
}

// A cluster whose kubeconfig is not loaded yet: its reason says the watch keeps trying, and it does.
func TestAWatchOfAClusterNotLoadedYetKeepsTryingAndComesBack(t *testing.T) {
	base := muxOn(t, eventThenHold)
	clients := &lateClients{fakeClients: base.provider.(fakeClients)}
	m := NewMultiplexer(clients)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	f := nextFrame(t, conn)
	if f.Type != "ERROR" || f.Error.Reason != reasonUnreachable {
		t.Fatalf("frame %s reason %q", f.Type, f.Error.Reason)
	}
	waitForSubscriptions(t, m, 1)

	clients.ready.Store(true)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if f := nextFrame(t, conn); f.Type != "RESYNC" {
		t.Fatalf("frame %s, want RESYNC", f.Type)
	}
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("frame %s, want the pods' frames", f.Type)
	}
}

// The screen splits a list into one watch per namespace for a grant limited to them, and leaves a kind of the cluster
// whole. The two lists have to name the same kinds.
func TestTheScreenKnowsTheKindsWithNoNamespace(t *testing.T) {
	raw, err := readFrontendFile("services/useKubeWatchList.ts")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(raw, "KINDS_OF_THE_CLUSTER = new Set([")
	if start < 0 {
		t.Fatal("KINDS_OF_THE_CLUSTER not found in useKubeWatchList.ts")
	}
	body := raw[start+len("KINDS_OF_THE_CLUSTER = new Set(") : start+strings.Index(raw[start:], "])")+1]
	body = strings.ReplaceAll(body, "'", `"`)
	body = strings.ReplaceAll(body, ",\n]", "\n]")
	var screen []string
	if err := json.Unmarshal([]byte(body), &screen); err != nil {
		t.Fatalf("%v in %s", err, body)
	}
	got := map[string]bool{}
	for _, kind := range screen {
		got[kind] = true
	}
	for kind := range clusterWideWatch {
		if !got[kind] {
			t.Errorf("the screen would split %s into one watch per namespace", kind)
		}
	}
	for kind := range got {
		if !clusterWideWatch[kind] {
			t.Errorf("the screen leaves %s whole and the server has no such kind of the cluster", kind)
		}
	}
}
