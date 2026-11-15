package ws

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"runtime"
	"runtime/metrics"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// openingAPI is an API server whose watches from no version send their objects one after another as they open, then,
// for a watch list (sendInitialEvents=true), the bookmark that ends them, then what changes says; a watch from a
// version gets one event and stays quiet. It counts the watches that are sending their objects at once.
type openingAPI struct {
	objects int
	gap     time.Duration
	// changes, when set, is how often a change (MODIFIED) comes once the objects are sent, until the watch ends.
	changes time.Duration
	// cut ends the first watch after its objects, before its bookmark.
	cut bool
	// noWatchList answers sendInitialEvents with kube-apiserver's 422 of a server whose WatchList gate is off.
	noWatchList bool

	mu            sync.Mutex
	sending, most int
	asked         []url.Values
	refused       int
}

func (s *openingAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := r.URL.Query()
	if q.Get("watch") != "true" && q.Get("watch") != "1" {
		fmt.Fprint(w, `{"kind":"PodList","apiVersion":"v1","metadata":{"resourceVersion":"100"},"items":[]}`)
		return
	}
	s.mu.Lock()
	s.asked = append(s.asked, q)
	first := len(s.asked) == 1
	if s.noWatchList && q.Get("sendInitialEvents") != "" {
		s.refused++
		s.mu.Unlock()
		w.WriteHeader(http.StatusUnprocessableEntity)
		fmt.Fprint(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"ListOptions.meta.k8s.io \"\" is invalid: sendInitialEvents: Forbidden: sendInitialEvents is forbidden for watch unless the WatchList feature gate is enabled","reason":"Invalid","code":422}`)
		return
	}
	s.mu.Unlock()
	if q.Get("resourceVersion") != "" && q.Get("resourceVersion") != "0" {
		eventThenHold(w, r)
		return
	}
	s.mu.Lock()
	s.sending++
	s.most = max(s.most, s.sending)
	s.mu.Unlock()
	for i := 0; i < s.objects && r.Context().Err() == nil; i++ {
		fmt.Fprintf(w, `{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-%d","namespace":"demo","resourceVersion":"%d"},"spec":{"containers":[]},"status":{"phase":"Running"}}}`+"\n", i, 10+i)
		w.(http.Flusher).Flush()
		time.Sleep(s.gap)
	}
	s.mu.Lock()
	s.sending--
	s.mu.Unlock()
	if s.cut && first {
		return
	}
	endInitialEvents(w, r, "v1", "Pod", "500")
	w.(http.Flusher).Flush()
	for i := 0; s.changes > 0 && r.Context().Err() == nil; i++ {
		fmt.Fprintf(w, `{"type":"MODIFIED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-0","namespace":"demo","resourceVersion":"%d"},"spec":{"containers":[]},"status":{"phase":"Running"}}}`+"\n", 600+i)
		w.(http.Flusher).Flush()
		time.Sleep(s.changes)
	}
	<-r.Context().Done()
}

func (s *openingAPI) mostAtOnce() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.most
}

func (s *openingAPI) queries() []url.Values {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]url.Values(nil), s.asked...)
}

// testCtx ends with the test, so a watch left running does not keep the fake API server's Close waiting.
func testCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return ctx
}

// drain reads out until ctx ends.
func drain(ctx context.Context, out <-chan *ResponseMessage) {
	for {
		select {
		case <-out:
		case <-ctx.Done():
			return
		}
	}
}

// firstFrame is the first frame of out, or "" after within.
func firstFrame(out <-chan *ResponseMessage, within time.Duration) string {
	select {
	case f := <-out:
		return f.Type
	case <-time.After(within):
		return ""
	}
}

// watchOn runs a watch of cluster as the multiplexer does.
func watchOn(ctx context.Context, m *Multiplexer, cluster, path, query string, out chan<- *ResponseMessage) {
	m.runWatch(ctx, RequestMessage{ClusterID: cluster, Path: path, Query: query}, out)
}

func eventually(t *testing.T, what string, within time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("not within %v: %s", within, what)
		}
		time.Sleep(time.Millisecond)
	}
}

// A watch from no version is asked as a watch list from the watch cache's version, and the watches of a restart open
// a few at a time: each reads its objects only while it holds an opening place, one cluster half of them, and every
// object reaches every list. At 700 people the openings after a restart took k8s-service from 121 to 285 MiB of live
// heap in two seconds while each watch went on at its first answer.
func TestWatchesOpenAFewAtATime(t *testing.T) {
	api := &chanAPI{objects: 20, gap: time.Millisecond}
	m := NewMultiplexer(chanClusters{string(cluster.Default): api})
	m.MaxWatchOpenings = 4
	ctx := testCtx(t)
	const subscriptions = 32
	var wg sync.WaitGroup
	frames := make([]int, subscriptions)
	for i := range frames {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan *ResponseMessage, 64)
			go chanWatch(ctx, m, string(cluster.Default), fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
			deadline := time.After(30 * time.Second)
			for frames[i] < api.objects {
				select {
				case f := <-out:
					if f.Type == "DATA" {
						frames[i]++
					}
				case <-deadline:
					return
				}
			}
		}()
	}
	wg.Wait()
	for i, n := range frames {
		if n != api.objects {
			t.Errorf("list %d got %d of the %d objects", i, n, api.objects)
		}
	}
	t.Logf("watches read at once: %d, for %d subscriptions and %d places (2 of one cluster)", api.mostAtOnce(), subscriptions, m.MaxWatchOpenings)
	if got := api.mostAtOnce(); got > 2 {
		t.Errorf("%d watches of one cluster were read at once, want at most its share of 2", got)
	}
	o := api.options()[0]
	if o.SendInitialEvents == nil || !*o.SendInitialEvents || o.ResourceVersionMatch != metav1.ResourceVersionMatchNotOlderThan || o.ResourceVersion != "0" || !o.AllowWatchBookmarks {
		t.Errorf("a watch from no version asked %+v, want a watch list from resourceVersion 0", o)
	}
}

// An opening reads its objects only while it holds its place: a second watch, started meanwhile, gets none until the
// first's bookmark, also past startHoldFor, which ends only a start the API server has not answered.
func TestAnOpeningHoldsItsPlaceUntilItsBookmark(t *testing.T) {
	api := &chanAPI{objects: 30, gap: 10 * time.Millisecond}
	m := NewMultiplexer(chanClusters{string(cluster.Default): api})
	m.MaxWatchOpenings = 2 // a cluster's share is 1
	m.openingHoldFor = 10 * time.Second
	m.startHoldFor = 50 * time.Millisecond
	ctx := testCtx(t)
	var firstDone atomic.Int64
	first, second := make(chan *ResponseMessage, 64), make(chan *ResponseMessage, 64)
	go func() {
		for frames := 0; ; {
			select {
			case f := <-first:
				if f.Type == "DATA" {
					if frames++; frames == api.objects {
						firstDone.Store(time.Now().UnixNano())
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	go chanWatch(ctx, m, string(cluster.Default), "watch=1", first)
	eventually(t, "the first watch to be read", 5*time.Second, func() bool { return api.mostAtOnce() == 1 })
	go chanWatch(ctx, m, string(cluster.Default), "watch=1&labelSelector=a%3D1", second)
	time.Sleep(100 * time.Millisecond) // a third of the first's objects
	if n := m.openingPlaces().InUse(); n != 1 {
		t.Errorf("%d opening places taken while the first watch's objects come, want 1", n)
	}
	select {
	case f := <-second:
		t.Fatalf("the second list got %s while the first opened", f.Type)
	default:
	}
	if typ := firstFrame(second, 5*time.Second); typ != "DATA" {
		t.Fatalf("the second list after the first's bookmark: %q, want DATA", typ)
	}
	if done := firstDone.Load(); done == 0 {
		t.Error("the second list's objects came before the first's were all read")
	}
}

// A watch list gives its place back at its bookmark, an empty one too, not at openingHoldFor.
func TestAWatchListGivesItsPlaceBackAtItsBookmark(t *testing.T) {
	for _, objects := range []int{0, 5} {
		t.Run(fmt.Sprintf("%d objects", objects), func(t *testing.T) {
			api := &openingAPI{objects: objects}
			m := muxOn(t, api.serve)
			m.MaxWatchOpenings = 1
			m.openingHoldFor = 10 * time.Second
			ctx := testCtx(t)
			first := make(chan *ResponseMessage, 16)
			go drain(ctx, first)
			go watchInto(ctx, m, "/api/v1/pods", "watch=1", first)
			eventually(t, "the opening place to come back after the bookmark", time.Second, func() bool {
				return len(api.queries()) == 1 && m.openingPlaces().InUse() == 0
			})
		})
	}
}

// A list that keeps changing once its objects are in holds no place: the next list opens at once, on a server that
// serves watch lists (the bookmark) and on one that does not (the first change).
func TestAListThatKeepsChangingHoldsNoPlace(t *testing.T) {
	for _, noWatchList := range []bool{false, true} {
		t.Run(fmt.Sprintf("watch list refused %v", noWatchList), func(t *testing.T) {
			api := &openingAPI{objects: 5, changes: 5 * time.Millisecond, noWatchList: noWatchList}
			m := muxOn(t, api.serve)
			m.MaxWatchOpenings = 1
			m.openingHoldFor = 10 * time.Second
			ctx := testCtx(t)
			busy, quiet := make(chan *ResponseMessage, 4), make(chan *ResponseMessage, 4)
			go drain(ctx, busy)
			go watchInto(ctx, m, "/api/v1/pods", "watch=1", busy)
			time.Sleep(100 * time.Millisecond)
			start := time.Now()
			go watchInto(ctx, m, "/api/v1/pods", "watch=1&labelSelector=a%3Dquiet", quiet)
			if typ := firstFrame(quiet, 2*time.Second); typ != "DATA" {
				t.Fatalf("a list behind one that keeps changing: %q after %v, want DATA", typ, time.Since(start))
			}
			t.Logf("first frame of the list behind it after %v", time.Since(start))
		})
	}
}

// A browser that reads slowly holds no place: the opening's place goes back when a frame would wait for it.
func TestASlowBrowserHoldsNoPlace(t *testing.T) {
	api := &openingAPI{objects: 1000}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.openingHoldFor = 10 * time.Second
	ctx := testCtx(t)
	slow := make(chan *ResponseMessage, 4)
	go func() {
		for {
			select {
			case <-slow:
				time.Sleep(10 * time.Millisecond)
			case <-ctx.Done():
				return
			}
		}
	}()
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", slow)
	eventually(t, "the slow browser's watch to start", 5*time.Second, func() bool { return len(api.queries()) == 1 })
	other := make(chan *ResponseMessage, 4)
	start := time.Now()
	go watchInto(ctx, m, "/api/v1/pods", "watch=1&labelSelector=a%3Dother", other)
	if typ := firstFrame(other, time.Second); typ != "DATA" {
		t.Fatalf("a list behind a slow browser's opening: %q after %v, want DATA", typ, time.Since(start))
	}
}

// A watch of changes takes no opening place: it starts at once behind an opening that holds every place.
func TestAWatchOfChangesDoesNotWaitBehindOpenings(t *testing.T) {
	api := &openingAPI{objects: 300, gap: 10 * time.Millisecond}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.MaxWatchStarts = 1 // the opening gave its start place back at its first answer
	m.openingHoldFor = 10 * time.Second
	ctx := testCtx(t)
	long := make(chan *ResponseMessage, 4)
	go drain(ctx, long)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", long)
	eventually(t, "the long opening to start", 5*time.Second, func() bool { return m.openingPlaces().InUse() == 1 })
	changes := make(chan *ResponseMessage, 4)
	start := time.Now()
	go watchInto(ctx, m, "/api/v1/pods", "watch=1&notify=1", changes)
	if typ := firstFrame(changes, time.Second); typ != "CHANGED" {
		t.Fatalf("a watch of changes behind a long opening: %q after %v, want CHANGED", typ, time.Since(start))
	}
}

// A cluster whose API server refuses sendInitialEvents (the WatchList gate off, as in 1.33) opens the watch the earlier
// way, and its next watches too, without asking again; another cluster still asks for a watch list.
func TestAClusterThatRefusesWatchListsOpensTheEarlierWay(t *testing.T) {
	api := &openingAPI{objects: 3, noWatchList: true}
	m := muxOn(t, api.serve)
	ctx := testCtx(t)
	for i := 0; i < 2; i++ {
		out := make(chan *ResponseMessage, 8)
		go watchOn(ctx, m, "alpha", "/api/v1/pods", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
		if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
			t.Fatalf("watch %d on a cluster that refuses watch lists: %q, want DATA", i, typ)
		}
	}
	api.mu.Lock()
	refused := api.refused
	api.mu.Unlock()
	if refused != 1 {
		t.Errorf("the cluster was asked for a watch list %d times, want once", refused)
	}
	for _, q := range api.queries()[1:] {
		if q.Get("sendInitialEvents") != "" || q.Get("resourceVersionMatch") != "" || q.Get("resourceVersion") != "" {
			t.Errorf("after the refusal a watch asked %v, want a watch from no version", q)
		}
	}
	before := len(api.queries())
	other := make(chan *ResponseMessage, 8)
	go watchOn(ctx, m, "beta", "/api/v1/pods", "watch=1", other)
	firstFrame(other, 5*time.Second)
	if q := api.queries()[before]; q.Get("sendInitialEvents") != "true" {
		t.Errorf("another cluster asked %v first, want a watch list", q)
	}
}

// On a server that serves no watch list the opening ends when no object comes for openingQuiet.
func TestAnOpeningWithoutAWatchListEndsWhenItsObjectsStop(t *testing.T) {
	api := &openingAPI{objects: 5, noWatchList: true}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.openingHoldFor = 10 * time.Second
	ctx := testCtx(t)
	first := make(chan *ResponseMessage, 16)
	go drain(ctx, first)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", first)
	eventually(t, "the earlier-way watch to start", 5*time.Second, func() bool { return len(api.queries()) == 2 })
	eventually(t, "the opening place to come back once the objects stopped", time.Second, func() bool { return m.openingPlaces().InUse() == 0 })
}

// An opening that does not end, on a server that sends objects without end, gives its place back at openingHoldFor
// and holds it until then.
func TestAnOpeningThatGoesOnGivesItsPlaceBackAfterAWhile(t *testing.T) {
	api := &openingAPI{objects: 400, gap: 5 * time.Millisecond}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.openingHoldFor = 300 * time.Millisecond
	ctx := testCtx(t)
	first, second := make(chan *ResponseMessage, 4), make(chan *ResponseMessage, 4)
	go drain(ctx, first)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", first)
	eventually(t, "the first watch to start", 5*time.Second, func() bool { return len(api.queries()) == 1 })
	go watchInto(ctx, m, "/api/v1/pods", "watch=1&labelSelector=a%3D1", second)
	time.Sleep(100 * time.Millisecond)
	select {
	case f := <-second:
		t.Errorf("the second list got %s before openingHoldFor", f.Type)
	default:
	}
	if typ := firstFrame(second, 2*time.Second); typ != "DATA" {
		t.Fatalf("the second list: %q, want DATA", typ)
	}
}

// An opening the API server ends before its bookmark gives its place back at once, and the next watch opens from no
// version again with the list read again: the last object's version is not the list's.
func TestAnOpeningCutMidwayGivesItsPlaceBackAndOpensAgain(t *testing.T) {
	api := &openingAPI{objects: 5, cut: true}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.openingHoldFor = 10 * time.Second
	ctx := testCtx(t)
	out := make(chan *ResponseMessage, 64)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
	eventually(t, "the cut opening's place to come back", time.Second, func() bool {
		return len(api.queries()) >= 1 && api.mostAtOnce() == 1 && m.openingPlaces().InUse() == 0
	})
	eventually(t, "the watch to open again", 5*time.Second, func() bool { return len(api.queries()) == 2 })
	if q := api.queries()[1]; q.Get("sendInitialEvents") != "true" || q.Get("resourceVersion") != "0" {
		t.Errorf("after the cut the watch asked %v, want a watch list again", q)
	}
	resync := false
	for !resync {
		select {
		case f := <-out:
			resync = f.Type == "RESYNC"
		case <-time.After(5 * time.Second):
			t.Fatal("no RESYNC after the cut opening")
		}
	}
}

// An opening whose RESYNC cannot be sent, its client gone, gives its place back at once.
func TestAnOpeningWhoseResyncCannotBeSentGivesItsPlaceBack(t *testing.T) {
	api := &openingAPI{objects: 1}
	m := muxOn(t, api.serve)
	m.MaxWatchOpenings = 1
	m.openingHoldFor = 10 * time.Second
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	out := make(chan *ResponseMessage) // nobody reads
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.runWatch(ctx, RequestMessage{Path: "/api/v1/pods", Query: "watch=1", Resync: true}, out)
	}()
	eventually(t, "the watch to reach the API server", 5*time.Second, func() bool { return len(api.queries()) == 1 })
	time.Sleep(20 * time.Millisecond)
	cancel()
	waitEnded(t, done, 5*time.Second)
	if n := m.openingPlaces().InUse(); n != 0 {
		t.Errorf("%d opening places taken after the RESYNC could not be sent", n)
	}
}

// A watch that has been on and has to open from no version again (its version expired) goes on while memory is short,
// as the watches already on do; a new one waits.
func TestAWatchThatWasOnOpensAgainWhileMemoryIsShort(t *testing.T) {
	var opened atomic.Int64
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, podEvent)
		endInitialEvents(w, r, "v1", "Pod", "10")
		w.(http.Flusher).Flush()
		if opened.Add(1) == 1 {
			fmt.Fprintln(w, expiredEvent)
			return
		}
		<-r.Context().Done()
	})
	var short atomic.Bool
	m.heap = func() (uint64, uint64) {
		if short.Load() {
			return 900, 1000
		}
		return 100, 1000
	}
	ctx := testCtx(t)
	out := make(chan *ResponseMessage, 16)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
	if f := <-out; f.Type != "DATA" {
		t.Fatalf("first frame %s, want DATA", f.Type)
	}
	short.Store(true)
	for _, want := range []string{"RESYNC", "DATA"} {
		select {
		case f := <-out:
			if f.Type != want {
				t.Fatalf("after its version expired while memory was short: %s %v, want %s", f.Type, f.Error, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no %s after the version expired", want)
		}
	}
	newOne := make(chan *ResponseMessage, 4)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1&labelSelector=a%3D1", newOne)
	select {
	case f := <-newOne:
		data, _ := f.Error.(map[string]string)
		if f.Type != "ERROR" || data["limit_scope"] != limitScopeMemory {
			t.Fatalf("a new watch while memory was short: %s %v, want the memory limit", f.Type, f.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a new watch while memory was short got nothing")
	}
}

// A watch whose turn comes while memory is short waits as a new one does: the limit frame (limit_scope "memory"), no
// request to the API server and no place kept. A crowd's subscriptions are all taken within a second, before the
// memory of their openings shows, so the share is asked again when each one is about to open.
func TestAWatchWhoseTurnComesWhileMemoryIsShortWaits(t *testing.T) {
	api := &startingWatches{}
	m := muxOn(t, api.serve)
	m.heap = func() (uint64, uint64) { return 900, 1000 }
	out := make(chan *ResponseMessage, 4)
	done := make(chan struct{})
	ctx := testCtx(t)
	go func() {
		defer close(done)
		watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
	}()
	waitEnded(t, done, 5*time.Second)
	f := <-out
	data, _ := f.Error.(map[string]string)
	if f.Type != "ERROR" || data["reason"] != reasonLimit || data["limit_scope"] != limitScopeMemory {
		t.Fatalf("a watch whose turn came while memory was short: %s %v", f.Type, f.Error)
	}
	if n := api.startedSoFar(); n != 0 {
		t.Errorf("%d watches reached the API server", n)
	}
	if n := m.watchStartPlaces("default").InUse() + m.openingPlaces().InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// A wait for an opening place past startNoticeAfter is told as the memory limit, once, not as a cluster that cannot be
// reached, and the list is read again once its watch is on.
func TestALongWaitForAnOpeningIsToldAsTheMemoryLimit(t *testing.T) {
	m := muxOn(t, eventThenHold)
	m.startNoticeAfter = 20 * time.Millisecond
	places := m.openingPlaces()
	held := make([]func(), 0, places.Cap())
	for i := 0; i < places.Cap(); i++ {
		release, err := places.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	ctx := testCtx(t)
	out := make(chan *ResponseMessage, 8)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
	f := <-out
	data, _ := f.Error.(map[string]string)
	if f.Type != "ERROR" || data["reason"] != reasonLimit || data["limit_scope"] != limitScopeMemory || !strings.Contains(data["message"], "waits for its turn") {
		t.Fatalf("after the long wait: %s %v", f.Type, f.Error)
	}
	for _, release := range held {
		release()
	}
	for _, want := range []string{"RESYNC", "DATA"} {
		if f := <-out; f.Type != want {
			t.Fatalf("when its turn came: %s, want %s", f.Type, want)
		}
	}
}

// What the collector's limit counts besides the live heap counts here too: at 700 people the goroutine stacks were
// 58-92 MiB of 461, and with the live heap alone the share was not reached before k8s-service ran out of memory.
func TestTheMemoryHeldCountsTheGoroutineStacks(t *testing.T) {
	const parked = 500
	stop := make(chan struct{})
	var ready sync.WaitGroup
	for i := 0; i < parked; i++ {
		ready.Add(1)
		go deepThenWait(48, &ready, stop)
	}
	ready.Wait()
	defer close(stop)
	runtime.GC()
	var h heapReading
	held, _ := h.read()
	s := []metrics.Sample{{Name: "/gc/heap/live:bytes"}, {Name: "/memory/classes/heap/stacks:bytes"}}
	metrics.Read(s)
	live, stacks := s[0].Value.Uint64(), s[1].Value.Uint64()
	t.Logf("held %d bytes: live heap %d, stacks %d", held, live, stacks)
	if held < live+stacks {
		t.Errorf("held %d bytes, want at least the live heap %d and the stacks %d", held, live, stacks)
	}
}

// deepThenWait grows its stack depth frames deep, then waits for stop.
func deepThenWait(depth int, ready *sync.WaitGroup, stop <-chan struct{}) byte {
	var pad [256]byte
	pad[depth%len(pad)] = byte(depth)
	if depth > 0 {
		return deepThenWait(depth-1, ready, stop) + pad[0]
	}
	ready.Done()
	<-stop
	return pad[0]
}

// The memory held is the live heap and what the runtime holds outside the heap's objects, its spans' unused room, its
// free and its returned memory.
func TestHeldBytes(t *testing.T) {
	for name, c := range map[string]struct{ live, total, objects, unused, free, released, want uint64 }{
		"stacks and metadata":   {live: 100, total: 1000, objects: 500, unused: 50, free: 100, released: 150, want: 300},
		"nothing outside":       {live: 100, total: 800, objects: 500, unused: 50, free: 100, released: 150, want: 100},
		"a reading out of step": {live: 100, total: 700, objects: 500, unused: 50, free: 100, released: 150, want: 100},
	} {
		if got := heldBytes(c.live, c.total, c.objects, c.unused, c.free, c.released); got != c.want {
			t.Errorf("%s: %d, want %d", name, got, c.want)
		}
	}
}
