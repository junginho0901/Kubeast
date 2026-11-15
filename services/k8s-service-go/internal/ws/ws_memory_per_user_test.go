package ws

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"runtime/pprof"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// TestWSMemoryPerUser measures what k8s-service keeps for each person with a screen open: the socket, and each watch it
// follows, as the W2 load test's people kept them. The browsers and a fake API server (TLS, HTTP/2, as kube-apiserver)
// run in a second process (TestWSMemoryPeer), so only the multiplexer's side is counted here. Run with
// WS_MEMORY_PER_USER=1; WS_MEMORY_USERS sets the crowd (300), WS_MEMORY_OUT a folder for the summary and the heap and
// goroutine profiles taken while the crowd is connected, WS_MEMORY_ONLY a comma-separated list of scenarios.
func TestWSMemoryPerUser(t *testing.T) {
	if os.Getenv("WS_MEMORY_PER_USER") != "1" {
		t.Skip("set WS_MEMORY_PER_USER=1 to measure")
	}
	users := 300
	if n, err := strconv.Atoi(os.Getenv("WS_MEMORY_USERS")); err == nil && n > 0 {
		users = n
	}
	out := os.Getenv("WS_MEMORY_OUT")

	peer := startMemPeer(t)
	cfg := &rest.Config{Host: peer.api, QPS: 100, Burst: 200, TLSClientConfig: rest.TLSClientConfig{Insecure: true}}
	// WS_MEMORY_H2_STREAM_BUFFER caps what the API server may send on one watch before it is read (HTTP/2 flow
	// control; Go's default is 4 MiB a stream).
	streamBuffer, _ := strconv.Atoi(os.Getenv("WS_MEMORY_H2_STREAM_BUFFER"))
	if streamBuffer > 0 {
		cfg.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
			if tr, ok := rt.(*http.Transport); ok {
				tr.HTTP2 = &http.HTTP2Config{MaxReceiveBufferPerStream: streamBuffer}
			}
			return rt
		}
	}
	d, err := dynamic.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m := NewMultiplexer(fakeClients{d})
	wsURL := memMuxServer(t, m)

	// One of each watch first: the HTTP/2 connection, the TLS session and the decoders' types are there before counting.
	peer.crowd(t, m, wsURL, [][]memWatch{memWatches(memPodsOnNode(0), memNodes(), memDeployments(""))}, nil)

	var summary strings.Builder
	fmt.Fprintf(&summary, "%s, %s %s/%s, GOGC default, GOMEMLIMIT %q, HTTP/2 stream buffer %d (0 = Go's 4 MiB)\n", time.Now().Format(time.RFC3339),
		runtime.Version(), runtime.GOOS, runtime.GOARCH, os.Getenv("GOMEMLIMIT"), streamBuffer)
	fmt.Fprintf(&summary, "one event on the wire: pod %d bytes, node %d bytes, deployment %d bytes\n", len(watchPodJSON(0)), len(memNodeJSON(0)), len(memDeploymentJSON(0)))
	fmt.Fprintf(&summary, "%-12s %6s %6s %9s %9s %9s %8s %9s %9s %9s\n", "scenario", "people", "watch", "live/p", "stack/p", "gor/p", "inuse/p", "rss/p", "peak/p", "left/p")
	for _, sc := range []struct {
		name   string
		people int
		plan   func(int) [][]memWatch
	}{
		{"socket", users, func(n int) [][]memWatch { return make([][]memWatch, n) }},
		{"pod-watch", users, func(n int) [][]memWatch {
			return memEach(n, func(int) []memWatch { return memWatches(memPodsOnNode(0)) })
		}},
		{"nodes-watch", users / 3, func(n int) [][]memWatch { return memEach(n, func(int) []memWatch { return memWatches(memNodes()) }) }},
		{"w2-kept", users, memW2Kept},
	} {
		if only := os.Getenv("WS_MEMORY_ONLY"); only != "" && !slices.Contains(strings.Split(only, ","), sc.name) {
			continue
		}
		plan := sc.plan(sc.people)
		watches := 0
		for _, p := range plan {
			watches += len(p)
		}
		var held memSnapshot
		before := takeMemSnapshot(true)
		peak := peer.crowd(t, m, wsURL, plan, func() {
			held = takeMemSnapshot(false)
			if out != "" {
				writeMemProfiles(t, out, sc.name)
			}
			live := takeMemSnapshot(true)
			held.heapAlloc, held.stackInuse, held.goroutines = live.heapAlloc, live.stackInuse, live.goroutines
		})
		after := takeMemSnapshot(true)
		per := func(a, b uint64) float64 { return (float64(a) - float64(b)) / float64(sc.people) / 1024 }
		line := fmt.Sprintf("%-12s %6d %6d %8.1fK %8.1fK %9.2f %7.1fK %8.1fK %8.1fK %8.1fK", sc.name, sc.people, watches,
			per(held.heapAlloc, before.heapAlloc), per(held.stackInuse, before.stackInuse),
			float64(held.goroutines-before.goroutines)/float64(sc.people), per(held.heapInuse, before.heapInuse),
			per(held.rssLike, before.rssLike), per(peak, before.rssLike), per(after.heapAlloc, before.heapAlloc))
		t.Log(line)
		summary.WriteString(line + "\n")
	}
	summary.WriteString("live = heap of live objects after a GC; stack = goroutine stacks; gor = goroutines; inuse = heap spans in use and\n" +
		"rss = memory the runtime holds and has not returned (Sys - HeapReleased), both before that GC; peak = the most rss while\n" +
		"the crowd connected; left = live heap after the crowd left. All per person, minus the same before the crowd came.\n")
	t.Log("\n" + summary.String())
	if out != "" {
		if err := os.WriteFile(filepath.Join(out, "summary.txt"), []byte(summary.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// An idle socket holds its reader, its session check and little else. It held 47 KiB of live heap while its queue
// took 256 frames as values and gorilla gave it a write buffer of its own; by pointer and from a pool, about 18 KiB
// (TestWSMemoryPerUser). The browsers run in a second process, so only the server's side is counted.
func TestAnIdleSocketHoldsLittleOfItsOwn(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a second process")
	}
	const sockets = 200
	peer := startMemPeer(t)
	m := NewMultiplexer(fakeClients{})
	wsURL := memMuxServer(t, m)
	peer.crowd(t, m, wsURL, [][]memWatch{nil}, nil)
	before := takeMemSnapshot(true)
	var perSocket float64
	peer.crowd(t, m, wsURL, make([][]memWatch, sockets), func() {
		held := takeMemSnapshot(true)
		perSocket = (float64(held.heapAlloc) - float64(before.heapAlloc)) / sockets / 1024
	})
	if perSocket > 30 {
		t.Errorf("an idle socket holds %.1f KiB of live heap, want at most 30", perSocket)
	}
	t.Logf("an idle socket holds %.1f KiB of live heap", perSocket)
}

// memMuxServer serves m's socket as k8s-service does behind the gateway: plain HTTP, each person signed in as an account
// of their own (?u=) with a live session check.
func memMuxServer(t *testing.T, m *Multiplexer) string {
	t.Helper()
	m.Sessions = auth.NewLiveSessions(auth.LiveSessionConfig{Lookup: func(context.Context, string, string) (auth.SessionState, error) { return auth.SessionState{}, nil }})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := auth.TokenPayload{UserID: "load-" + r.URL.Query().Get("u"), Perms: everyCluster}
		m.HandleWebSocket(w, r.WithContext(auth.WithPayload(cluster.WithID(r.Context(), cluster.Default), p)))
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

// memWatch is one watch a person's tab asks for, and how many objects it gets as it opens.
type memWatch struct {
	Path   string `json:"path"`
	Query  string `json:"query"`
	Frames int    `json:"frames"`
}

func memWatches(ws ...memWatch) []memWatch { return ws }

func memEach(n int, f func(int) []memWatch) [][]memWatch {
	plan := make([][]memWatch, n)
	for i := range plan {
		plan[i] = f(i)
	}
	return plan
}

func memWatchOf(path, query string) memWatch {
	return memWatch{Path: path, Query: query, Frames: memInitialObjects(path)}
}

// memPodsOnNode is a Cluster View node box of a person who may list every pod (screens.json, kind read).
func memPodsOnNode(node int) memWatch {
	return memWatchOf("/api/v1/pods", "watch=1&fieldSelector="+url.QueryEscape(fmt.Sprintf("spec.nodeName=kwok-node-%04d", node)))
}

func memNodes() memWatch { return memWatchOf("/api/v1/nodes", "watch=1") }

func memDeployments(namespace string) memWatch {
	if namespace == "" {
		return memWatchOf("/apis/apps/v1/deployments", "watch=1")
	}
	return memWatchOf("/apis/apps/v1/namespaces/"+namespace+"/deployments", "watch=1")
}

// memInitialObjects is what the fake API server sends as a watch from no version opens, the objects there are: the W2
// kwok cluster's 1 000 nodes, about 50 pods on a node (50 000 pods, almost all in bulk), its deployments.
func memInitialObjects(path string) int {
	bulkOrAll := !strings.Contains(path, "/namespaces/") || strings.Contains(path, "/namespaces/bulk/")
	switch {
	case strings.HasSuffix(path, "/nodes"):
		return 1000
	case strings.HasSuffix(path, "/pods") && bulkOrAll:
		return 50
	case strings.HasSuffix(path, "/pods"):
		return 1
	case strings.HasSuffix(path, "/deployments") && bulkOrAll:
		return 200
	default:
		return 3
	}
}

// memW2Kept is the screen each person of W2 kept open at the end and its watches as screens.json has them. limit-0300
// kept, of 300 people, Pods 63, Deployments 54, Nodes 62, Timeline 35, Cluster View 52 and the dashboard 34; one
// account in five is limited to 5 or 20 namespaces (accounts.py) and watches each of them (useKubeWatchList), up to the
// tab's 50.
func memW2Kept(n int) [][]memWatch {
	r := rand.New(rand.NewPCG(7, 7))
	weights := []struct {
		screen string
		weight int
	}{{"pods", 63}, {"deployments", 54}, {"nodes", 62}, {"timeline", 35}, {"view", 52}, {"dashboard", 34}}
	return memEach(n, func(i int) []memWatch {
		var namespaces []string
		load := func(from, to int) []string {
			var ns []string
			for k := from; k < to; k++ {
				ns = append(ns, fmt.Sprintf("load-ns-%02d", k))
			}
			return ns
		}
		switch i % 20 {
		case 0:
			namespaces = append([]string{"bulk"}, load(0, 4)...)
		case 10:
			namespaces = load(0, 5)
		case 5:
			namespaces = append([]string{"bulk"}, load(0, 19)...)
		case 15:
			namespaces = load(0, 20)
		}
		pick := r.IntN(300)
		screen := ""
		for _, w := range weights {
			if pick < w.weight {
				screen = w.screen
				break
			}
			pick -= w.weight
		}
		var ws []memWatch
		switch screen {
		case "view":
			for node := 0; node < 4; node++ {
				if namespaces == nil {
					ws = append(ws, memPodsOnNode(node))
					continue
				}
				for _, ns := range namespaces {
					ws = append(ws, memWatchOf("/api/v1/namespaces/"+ns+"/pods", "watch=1&fieldSelector="+url.QueryEscape(fmt.Sprintf("spec.nodeName=kwok-node-%04d", node))))
				}
			}
		case "deployments":
			if namespaces == nil {
				ws = append(ws, memDeployments(""))
			}
			for _, ns := range namespaces {
				ws = append(ws, memDeployments(ns))
			}
		case "nodes":
			ws = append(ws, memNodes())
		}
		if len(ws) > defaultMaxSubscriptionsPerConn {
			ws = ws[:defaultMaxSubscriptionsPerConn]
		}
		return ws
	})
}

type memSnapshot struct {
	heapAlloc, heapInuse, stackInuse, rssLike uint64
	goroutines                                int
}

func takeMemSnapshot(gc bool) memSnapshot {
	if gc {
		runtime.GC()
		runtime.GC()
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return memSnapshot{heapAlloc: ms.HeapAlloc, heapInuse: ms.HeapInuse, stackInuse: ms.StackInuse, rssLike: ms.Sys - ms.HeapReleased, goroutines: runtime.NumGoroutine()}
}

// memHeld is Sys - HeapReleased from runtime/metrics, which does not stop the world.
func memHeld() uint64 {
	s := []metrics.Sample{{Name: "/memory/classes/total:bytes"}, {Name: "/memory/classes/heap/released:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64() - s[1].Value.Uint64()
}

func writeMemProfiles(t *testing.T, dir, name string) {
	t.Helper()
	runtime.GC()
	for _, p := range []struct{ profile, file string }{{"heap", name + ".heap.pb.gz"}, {"goroutine", name + ".goroutines.txt"}} {
		f, err := os.Create(filepath.Join(dir, p.file))
		if err != nil {
			t.Fatal(err)
		}
		debug := 0
		if p.profile == "goroutine" {
			debug = 1
		}
		if err := pprof.Lookup(p.profile).WriteTo(f, debug); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
}

type memPeer struct {
	api   string
	in    io.Writer
	lines chan string
}

// startMemPeer runs TestWSMemoryPeer in a second process and reads its API server's address.
func startMemPeer(t *testing.T) *memPeer {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestWSMemoryPeer$")
	cmd.Env = append(os.Environ(), "WS_MEMORY_PEER=1")
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &memPeer{in: in, lines: make(chan string, 16)}
	t.Cleanup(func() {
		_ = in.Close()
		_ = cmd.Wait()
	})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if s, ok := strings.CutPrefix(sc.Text(), "WSMEM "); ok {
				p.lines <- s
			}
		}
		close(p.lines)
	}()
	p.api = strings.TrimPrefix(p.next(t), "API ")
	return p
}

func (p *memPeer) next(t *testing.T) string {
	t.Helper()
	select {
	case s, ok := <-p.lines:
		if !ok {
			t.Fatal("the peer process ended")
		}
		return s
	case <-time.After(5 * time.Minute):
		t.Fatal("no answer from the peer process")
	}
	return ""
}

// crowd connects plan's people, waits for every watch's first objects, calls held while they stay, and lets them go.
// It returns the most memory the runtime held meanwhile.
func (p *memPeer) crowd(t *testing.T, m *Multiplexer, wsURL string, plan [][]memWatch, held func()) uint64 {
	t.Helper()
	b, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	watches := 0
	for _, w := range plan {
		watches += len(w)
	}
	var peak atomic.Uint64
	done := make(chan struct{})
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			if h := memHeld(); h > peak.Load() {
				peak.Store(h)
			}
			select {
			case <-done:
				return
			case <-tick.C:
			}
		}
	}()
	fmt.Fprintf(p.in, "OPEN %s %s\n", wsURL, b)
	if got := p.next(t); !strings.HasPrefix(got, "READY ") {
		t.Fatalf("peer: %s", got)
	}
	waitSubscriptions(t, m, watches)
	close(done)
	time.Sleep(2 * time.Second)
	if held != nil {
		held()
	}
	fmt.Fprintln(p.in, "CLOSE")
	if got := p.next(t); got != "CLOSED" {
		t.Fatalf("peer: %s", got)
	}
	waitSubscriptions(t, m, 0)
	return peak.Load()
}

func waitSubscriptions(t *testing.T, m *Multiplexer, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for m.SubscriptionCount() != want {
		if time.Now().After(deadline) {
			t.Fatalf("live subscriptions = %d, want %d", m.SubscriptionCount(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestWSMemoryPeer is the other side of TestWSMemoryPerUser: a fake API server and the people's browsers, driven by
// lines on stdin (OPEN <ws url> <plan>, CLOSE).
func TestWSMemoryPeer(t *testing.T) {
	if os.Getenv("WS_MEMORY_PEER") != "1" {
		t.Skip("started by TestWSMemoryPerUser")
	}
	api := httptest.NewUnstartedServer(http.HandlerFunc(memAPI))
	api.EnableHTTP2 = true
	api.StartTLS()
	defer api.Close()
	fmt.Printf("WSMEM API %s\n", api.URL)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	var conns []*websocket.Conn
	for sc.Scan() {
		cmd, arg, _ := strings.Cut(sc.Text(), " ")
		switch cmd {
		case "OPEN":
			target, raw, _ := strings.Cut(arg, " ")
			var plan [][]memWatch
			if err := json.Unmarshal([]byte(raw), &plan); err != nil {
				fmt.Printf("WSMEM ERROR %v\n", err)
				continue
			}
			var frames, refused atomic.Int64
			want := int64(0)
			for _, ws := range plan {
				for _, w := range ws {
					want += int64(w.Frames)
				}
			}
			conns = make([]*websocket.Conn, len(plan))
			var wg sync.WaitGroup
			places := make(chan struct{}, 16)
			for i, ws := range plan {
				wg.Add(1)
				places <- struct{}{}
				go func() {
					defer wg.Done()
					defer func() { <-places }()
					conn, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("%s?u=%d", target, i), nil)
					if err != nil {
						fmt.Printf("WSMEM ERROR dial %v\n", err)
						return
					}
					conns[i] = conn
					go func() {
						for {
							_, data, err := conn.ReadMessage()
							if err != nil {
								return
							}
							switch {
							case bytes.HasPrefix(data, []byte(`{"type":"DATA"`)):
								frames.Add(1)
							case bytes.HasPrefix(data, []byte(`{"type":"ERROR"`)):
								refused.Add(1)
							}
						}
					}()
					for _, w := range ws {
						_ = conn.WriteJSON(RequestMessage{Type: "REQUEST", ClusterID: string(cluster.Default), Path: w.Path, Query: w.Query})
					}
				}()
			}
			wg.Wait()
			deadline := time.Now().Add(4 * time.Minute)
			for frames.Load() < want && refused.Load() == 0 && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
			}
			fmt.Printf("WSMEM READY %d/%d refused %d\n", frames.Load(), want, refused.Load())
		case "CLOSE":
			for _, c := range conns {
				if c != nil {
					_ = c.Close()
				}
			}
			conns = nil
			fmt.Println("WSMEM CLOSED")
		}
	}
}

var memObjects struct {
	once                     sync.Once
	pods, nodes, deployments [][]byte
}

// memAPI answers a watch as kube-apiserver does from no version: the objects there are as ADDED, then nothing until the
// client goes. Any other GET is an empty list.
func memAPI(w http.ResponseWriter, r *http.Request) {
	memObjects.once.Do(func() {
		for i := 0; i < 1000; i++ {
			memObjects.nodes = append(memObjects.nodes, append(memNodeJSON(i), '\n'))
		}
		for i := 0; i < 200; i++ {
			memObjects.pods = append(memObjects.pods, append(watchPodJSON(i), '\n'))
			memObjects.deployments = append(memObjects.deployments, append(memDeploymentJSON(i), '\n'))
		}
	})
	w.Header().Set("Content-Type", "application/json")
	if q := r.URL.Query().Get("watch"); q != "true" && q != "1" {
		fmt.Fprint(w, `{"kind":"List","apiVersion":"v1","metadata":{"resourceVersion":"1"},"items":[]}`)
		return
	}
	objects := memObjects.pods
	switch {
	case strings.HasSuffix(r.URL.Path, "/nodes"):
		objects = memObjects.nodes
	case strings.HasSuffix(r.URL.Path, "/deployments"):
		objects = memObjects.deployments
	}
	for i := 0; i < memInitialObjects(r.URL.Path); i++ {
		if _, err := w.Write(objects[i%len(objects)]); err != nil {
			return
		}
	}
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

// memNodeJSON is a kwok node as the API server sends it on a watch.
func memNodeJSON(i int) []byte {
	now := metav1.NewTime(time.Unix(1_794_000_000, 0))
	name := fmt.Sprintf("kwok-node-%04d", i)
	managed := func(manager, sub, raw string) metav1.ManagedFieldsEntry {
		return metav1.ManagedFieldsEntry{Manager: manager, Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "v1", Subresource: sub, Time: &now, FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(raw)}}
	}
	condition := func(kind corev1.NodeConditionType, status corev1.ConditionStatus, reason, message string) corev1.NodeCondition {
		return corev1.NodeCondition{Type: kind, Status: status, LastHeartbeatTime: now, LastTransitionTime: now, Reason: reason, Message: message}
	}
	resources := corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("32"), corev1.ResourceMemory: resource.MustParse("256Gi"), corev1.ResourcePods: resource.MustParse("110")}
	node := corev1.Node{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Node"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, UID: types.UID(fmt.Sprintf("1b2c3d4e-0000-4000-8000-%012d", i)), ResourceVersion: fmt.Sprint(2_000_000 + i), CreationTimestamp: now,
			Labels: map[string]string{"beta.kubernetes.io/arch": "amd64", "beta.kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64", "kubernetes.io/hostname": name,
				"kubernetes.io/os": "linux", "kubernetes.io/role": "agent", "node-role.kubernetes.io/agent": "", "type": "kwok"},
			Annotations: map[string]string{"kwok.x-k8s.io/node": "fake", "node.alpha.kubernetes.io/ttl": "0"},
			ManagedFields: []metav1.ManagedFieldsEntry{
				managed("kwokctl", "", `{"f:metadata":{"f:annotations":{".":{},"f:kwok.x-k8s.io/node":{},"f:node.alpha.kubernetes.io/ttl":{}},"f:labels":{".":{},"f:beta.kubernetes.io/arch":{},"f:beta.kubernetes.io/os":{},"f:kubernetes.io/arch":{},"f:kubernetes.io/hostname":{},"f:kubernetes.io/os":{},"f:kubernetes.io/role":{},"f:node-role.kubernetes.io/agent":{},"f:type":{}}},"f:spec":{"f:taints":{}}}`),
				managed("kwok", "status", `{"f:status":{"f:addresses":{".":{},"k:{\"type\":\"InternalIP\"}":{".":{},"f:address":{},"f:type":{}}},"f:allocatable":{".":{},"f:cpu":{},"f:memory":{},"f:pods":{}},"f:capacity":{".":{},"f:cpu":{},"f:memory":{},"f:pods":{}},"f:conditions":{".":{},"k:{\"type\":\"DiskPressure\"}":{".":{},"f:lastHeartbeatTime":{},"f:lastTransitionTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}},"k:{\"type\":\"MemoryPressure\"}":{".":{},"f:lastHeartbeatTime":{},"f:lastTransitionTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}},"k:{\"type\":\"PIDPressure\"}":{".":{},"f:lastHeartbeatTime":{},"f:lastTransitionTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}},"k:{\"type\":\"Ready\"}":{".":{},"f:lastHeartbeatTime":{},"f:lastTransitionTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}}},"f:daemonEndpoints":{"f:kubeletEndpoint":{"f:Port":{}}},"f:nodeInfo":{"f:architecture":{},"f:bootID":{},"f:containerRuntimeVersion":{},"f:kernelVersion":{},"f:kubeletVersion":{},"f:machineID":{},"f:operatingSystem":{},"f:osImage":{},"f:systemUUID":{}},"f:phase":{}}}`),
			},
		},
		Spec: corev1.NodeSpec{Taints: []corev1.Taint{{Key: "kwok.x-k8s.io/node", Value: "fake", Effect: corev1.TaintEffectNoSchedule}}},
		Status: corev1.NodeStatus{
			Capacity: resources, Allocatable: resources, Phase: corev1.NodeRunning,
			Conditions: []corev1.NodeCondition{
				condition(corev1.NodeReady, corev1.ConditionTrue, "KubeletReady", "kubelet is posting ready status"),
				condition(corev1.NodeMemoryPressure, corev1.ConditionFalse, "KubeletHasSufficientMemory", "kubelet has sufficient memory available"),
				condition(corev1.NodeDiskPressure, corev1.ConditionFalse, "KubeletHasNoDiskPressure", "kubelet has no disk pressure"),
				condition(corev1.NodePIDPressure, corev1.ConditionFalse, "KubeletHasSufficientPID", "kubelet has sufficient PID available"),
			},
			Addresses:       []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: fmt.Sprintf("10.0.%d.%d", i/250, i%250+1)}},
			DaemonEndpoints: corev1.NodeDaemonEndpoints{KubeletEndpoint: corev1.DaemonEndpoint{Port: 10250}},
			NodeInfo: corev1.NodeSystemInfo{Architecture: "amd64", BootID: "", ContainerRuntimeVersion: "kwok-v0.7.0", KernelVersion: "kwok-v0.7.0",
				KubeletVersion: "fake", MachineID: "", OperatingSystem: "linux", OSImage: "kwok-v0.7.0", SystemUUID: ""},
		},
	}
	b, _ := json.Marshal(map[string]any{"type": "ADDED", "object": node})
	return b
}

// memDeploymentJSON is a deployment of the bulk namespace as the API server sends it on a watch.
func memDeploymentJSON(i int) []byte {
	now := metav1.NewTime(time.Unix(1_794_000_000, 0))
	name := fmt.Sprintf("bulk-%03d", i)
	replicas := int32(100)
	labels := map[string]string{"app": name}
	deployment := appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: "bulk", UID: types.UID(fmt.Sprintf("2c3d4e5f-0000-4000-8000-%012d", i)), ResourceVersion: fmt.Sprint(3_000_000 + i), Generation: 1,
			CreationTimestamp: now, Labels: labels, Annotations: map[string]string{"deployment.kubernetes.io/revision": "1"},
			ManagedFields: []metav1.ManagedFieldsEntry{
				{Manager: "kubectl-client-side-apply", Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "apps/v1", Time: &now, FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:metadata":{"f:labels":{".":{},"f:app":{}}},"f:spec":{"f:progressDeadlineSeconds":{},"f:replicas":{},"f:revisionHistoryLimit":{},"f:selector":{},"f:strategy":{"f:rollingUpdate":{".":{},"f:maxSurge":{},"f:maxUnavailable":{}},"f:type":{}},"f:template":{"f:metadata":{"f:labels":{".":{},"f:app":{}}},"f:spec":{"f:containers":{"k:{\"name\":\"app\"}":{".":{},"f:image":{},"f:imagePullPolicy":{},"f:name":{},"f:resources":{},"f:terminationMessagePath":{},"f:terminationMessagePolicy":{}}},"f:dnsPolicy":{},"f:restartPolicy":{},"f:schedulerName":{},"f:securityContext":{},"f:terminationGracePeriodSeconds":{}}}}}`)}},
				{Manager: "kube-controller-manager", Operation: metav1.ManagedFieldsOperationUpdate, APIVersion: "apps/v1", Subresource: "status", Time: &now, FieldsType: "FieldsV1", FieldsV1: &metav1.FieldsV1{Raw: []byte(`{"f:metadata":{"f:annotations":{".":{},"f:deployment.kubernetes.io/revision":{}}},"f:status":{"f:availableReplicas":{},"f:conditions":{".":{},"k:{\"type\":\"Available\"}":{".":{},"f:lastTransitionTime":{},"f:lastUpdateTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}},"k:{\"type\":\"Progressing\"}":{".":{},"f:lastTransitionTime":{},"f:lastUpdateTime":{},"f:message":{},"f:reason":{},"f:status":{},"f:type":{}}},"f:observedGeneration":{},"f:readyReplicas":{},"f:replicas":{},"f:updatedReplicas":{}}}`)}},
			},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas, Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: corev1.PodSpec{
				Containers: []corev1.Container{{Name: "app", Image: "fake-image", TerminationMessagePath: "/dev/termination-log", TerminationMessagePolicy: "File", ImagePullPolicy: "IfNotPresent"}},
			}},
		},
		Status: appsv1.DeploymentStatus{
			ObservedGeneration: 1, Replicas: replicas, UpdatedReplicas: replicas, ReadyReplicas: replicas, AvailableReplicas: replicas,
			Conditions: []appsv1.DeploymentCondition{
				{Type: appsv1.DeploymentAvailable, Status: corev1.ConditionTrue, LastUpdateTime: now, LastTransitionTime: now, Reason: "MinimumReplicasAvailable", Message: "Deployment has minimum availability."},
				{Type: appsv1.DeploymentProgressing, Status: corev1.ConditionTrue, LastUpdateTime: now, LastTransitionTime: now, Reason: "NewReplicaSetAvailable", Message: fmt.Sprintf("ReplicaSet %q has successfully progressed.", name+"-75f744489b")},
			},
		},
	}
	b, _ := json.Marshal(map[string]any{"type": "ADDED", "object": deployment})
	return b
}
