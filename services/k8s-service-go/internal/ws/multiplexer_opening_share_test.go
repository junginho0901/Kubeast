package ws

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"runtime/metrics"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// The opening places are the server's: openings of two clusters together stay within them, and both clusters open.
func TestOpeningsOfEveryClusterShareThePlaces(t *testing.T) {
	both := &tally{}
	alpha := &chanAPI{objects: 20, gap: time.Millisecond, also: both}
	beta := &chanAPI{objects: 20, gap: time.Millisecond, also: both}
	m := NewMultiplexer(chanClusters{"alpha": alpha, "beta": beta})
	m.MaxWatchOpenings = 4
	ctx := testCtx(t)
	var wg sync.WaitGroup
	var lists atomic.Int64
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan *ResponseMessage, 64)
			go chanWatch(ctx, m, []string{"alpha", "beta"}[i%2], fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
			frames := 0
			deadline := time.After(30 * time.Second)
			for frames < 20 {
				select {
				case f := <-out:
					if f.Type == "DATA" {
						frames++
					}
				case <-deadline:
					return
				}
			}
			lists.Add(1)
		}()
	}
	wg.Wait()
	if n := lists.Load(); n != 24 {
		t.Errorf("%d of 24 lists got their objects", n)
	}
	t.Logf("read at once: alpha %d, beta %d, both %d", alpha.mostAtOnce(), beta.mostAtOnce(), both.mostAtOnce())
	if got := both.mostAtOnce(); got > 4 {
		t.Errorf("%d watches of two clusters read at once, want at most the server's 4 places", got)
	}
}

// A cluster whose API server has not answered a start holds one opening place at a time: beside two such clusters,
// another cluster's 50 lists open at once, and the dead clusters try again after startHoldFor. On 70c842dc (one such
// cluster) they waited 11.8 s, its watches holding every place for openingHoldFor each.
func TestAClusterThatDoesNotAnswerHoldsOneOpeningPlace(t *testing.T) {
	dead1, dead2, ok := &chanAPI{hang: true}, &chanAPI{hang: true}, &chanAPI{objects: 1}
	m := NewMultiplexer(chanClusters{"dead1": dead1, "dead2": dead2, "ok": ok})
	m.startHoldFor = time.Second
	ctx := testCtx(t)
	for i := 0; i < 50; i++ {
		out := make(chan *ResponseMessage, 4)
		go drain(ctx, out)
		go chanWatch(ctx, m, []string{"dead1", "dead2"}[i%2], fmt.Sprintf("watch=1&labelSelector=d%%3D%d", i), out)
	}
	time.Sleep(100 * time.Millisecond)
	opened, last, limits := crowdOpens(ctx, m, "ok", 50, 10*time.Second)
	t.Logf("healthy cluster: %d/50 opened, the last after %v, %d limit frames; the dead clusters were asked %d and %d watches", opened, last, limits, len(dead1.options()), len(dead2.options()))
	if opened != 50 || last > time.Second || limits != 0 {
		t.Errorf("beside clusters that do not answer %d of 50 lists opened, the last after %v, with %d limit frames; want all within 1 s and none", opened, last, limits)
	}
	if n1, n2 := len(dead1.options()), len(dead2.options()); n1 > 1 || n2 > 1 {
		t.Errorf("the dead clusters were asked %d and %d watches within startHoldFor, want one each", n1, n2)
	}
	// A start the API server keeps waiting gives its place back at startHoldFor: the cluster's next watch tries.
	eventually(t, "the dead cluster's next watch to start after startHoldFor", 5*time.Second, func() bool { return len(dead1.options()) > 1 })
}

// A wait for a place whose notice cannot reach the browser (its socket's queue full) holds the place it then takes no
// longer than its time: the time starts when the place is taken, not when the notice is through.
func TestAPlaceTakenWhileItsNoticeWaitsGoesBackInTime(t *testing.T) {
	api := &chanAPI{objects: 1}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.MaxWatchStarts = 1
	m.startNoticeAfter = 10 * time.Millisecond
	m.startHoldFor = 100 * time.Millisecond
	places := m.watchStartPlaces("alpha")
	give, err := places.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx := testCtx(t)
	go chanWatch(ctx, m, "alpha", "watch=1", make(chan *ResponseMessage)) // nobody reads: the notice waits
	time.Sleep(50 * time.Millisecond)
	give()
	eventually(t, "the waiting watch to take the place", time.Second, func() bool { return places.InUse() == 1 })
	eventually(t, "the place to go back at startHoldFor while the notice still waits", time.Second, func() bool { return places.InUse() == 0 })
}

// A cluster whose API server answers every watch with a 503 after a while (overloaded, or a proxy timing out) is not
// answering either: it holds one opening place at a time, and another cluster's lists open at once. On 70c842dc (3 s,
// 60 watches) the other cluster's last list took 8.0 s.
func TestAClusterThatFailsLateHoldsOneOpeningPlace(t *testing.T) {
	dead, ok := &chanAPI{failAfter: 300 * time.Millisecond}, &chanAPI{objects: 1}
	m := NewMultiplexer(chanClusters{"dead": dead, "ok": ok})
	ctx := testCtx(t)
	for i := 0; i < 60; i++ {
		out := make(chan *ResponseMessage, 4)
		go drain(ctx, out)
		go chanWatch(ctx, m, "dead", fmt.Sprintf("watch=1&labelSelector=d%%3D%d", i), out)
	}
	q := m.openingPlaces()
	most := 0
	for end := time.Now().Add(1500 * time.Millisecond); time.Now().Before(end); time.Sleep(time.Millisecond) {
		most = max(most, q.heldBy("dead")) // past the first 503s: the dead watches are retrying
	}
	opened, last, limits := crowdOpens(ctx, m, "ok", 50, 10*time.Second)
	t.Logf("healthy cluster: %d/50 opened, the last after %v, %d limit frames; the dead cluster held at most %d places", opened, last, limits, most)
	if opened != 50 || last > 2*time.Second || limits != 0 {
		t.Errorf("beside a cluster that fails late %d of 50 lists opened, the last after %v, with %d limit frames; want all within 2 s and none", opened, last, limits)
	}
	if most != 1 {
		t.Errorf("a cluster whose starts end in a 503 held %d places at once, want 1", most)
	}
}

// A watch list the API server sends without its bookmark (it takes sendInitialEvents and ignores it, as something in
// front of it might) holds its place until openingHoldFor; after noBookmarkCaps in a row the cluster's watches open the
// earlier way, which end in openingQuiet.
func TestAClusterThatSendsNoBookmarkOpensTheEarlierWay(t *testing.T) {
	api := &chanAPI{objects: 2, noBookmark: true}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.openingHoldFor = 200 * time.Millisecond
	ctx := testCtx(t)
	capped := func(n int) bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, refused := m.noWatchList["alpha"]
		return m.noBookmark["alpha"] == n || (n == noBookmarkCaps && refused)
	}
	for i := 0; i < noBookmarkCaps; i++ {
		out := make(chan *ResponseMessage, 16)
		go chanWatch(ctx, m, "alpha", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
		if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
			t.Fatalf("watch %d: %q, want DATA", i, typ)
		}
		eventually(t, fmt.Sprintf("watch %d to reach openingHoldFor", i), 5*time.Second, func() bool { return capped(i + 1) })
	}
	out := make(chan *ResponseMessage, 16)
	go chanWatch(ctx, m, "alpha", "watch=1&labelSelector=a%3Dlast", out)
	if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
		t.Fatalf("the watch after %d without a bookmark: %q, want DATA", noBookmarkCaps, typ)
	}
	asked := api.options()
	for i, o := range asked[:noBookmarkCaps] {
		if o.SendInitialEvents == nil {
			t.Errorf("watch %d asked %+v, want a watch list", i, o)
		}
	}
	if o := asked[noBookmarkCaps]; o.SendInitialEvents != nil || o.ResourceVersion != "" {
		t.Errorf("after %d watch lists without a bookmark the next asked %+v, want a watch from no version", noBookmarkCaps, o)
	}
	eventually(t, "the earlier way's opening to end in openingQuiet", time.Second, func() bool { return m.openingPlaces().InUse() == 0 })
}

// A crowd's watches that waited for their cluster's share ask as the ones before them found: once noBookmarkCaps watch
// lists went without their bookmark, the others open the earlier way and end in openingQuiet, not openingHoldFor. On
// 70c842dc (review probe R8) 24 such openings took 4.0 s with 2 s each, and 10.0 s before this order.
func TestACrowdBehindWatchListsWithoutABookmarkOpensTheEarlierWay(t *testing.T) {
	api := &chanAPI{objects: 5, noBookmark: true}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.openingHoldFor = 300 * time.Millisecond
	ctx := testCtx(t)
	opened, last, limits := crowdOpens(ctx, m, "alpha", 24, 10*time.Second)
	watchLists := 0
	for _, o := range api.options() {
		if o.SendInitialEvents != nil {
			watchLists++
		}
	}
	t.Logf("%d/24 opened, the last after %v, %d limit frames, %d asked as watch lists", opened, last, limits, watchLists)
	if opened != 24 || last > time.Second {
		t.Errorf("%d of 24 lists opened, the last after %v; want all within 1 s", opened, last)
	}
	// The first places, and those that took a place given back before noBookmarkCaps had been counted.
	if most := m.maxWatchOpenings() + noBookmarkCaps - 1; watchLists > most {
		t.Errorf("%d watches asked for a watch list, want at most %d", watchLists, most)
	}
}

// A watch list that ends in its bookmark ends a row of them without one: what counts is noBookmarkCaps in a row.
func TestABookmarkEndsARowOfWatchListsWithoutOne(t *testing.T) {
	api := &chanAPI{objects: 2, noBookmark: true, bookmarkFor: "a=with"}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.openingHoldFor = 200 * time.Millisecond
	ctx := testCtx(t)
	strikes := func() int {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.noBookmark["alpha"]
	}
	open := func(selector string, want int) {
		out := make(chan *ResponseMessage, 16)
		go chanWatch(ctx, m, "alpha", "watch=1&labelSelector="+url.QueryEscape(selector), out)
		if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
			t.Fatalf("watch %s: %q, want DATA", selector, typ)
		}
		eventually(t, fmt.Sprintf("%d watch lists in a row without a bookmark after %s", want, selector), 5*time.Second, func() bool { return strikes() == want })
	}
	for i := 1; i < noBookmarkCaps; i++ {
		open(fmt.Sprintf("a=%d", i), i)
	}
	open("a=with", 0)
	for i := 1; i < noBookmarkCaps; i++ {
		open(fmt.Sprintf("b=%d", i), i)
	}
	for i, o := range api.options() {
		if o.SendInitialEvents == nil {
			t.Errorf("watch %d asked %+v, want a watch list: no %d in a row went without a bookmark", i, o, noBookmarkCaps)
		}
	}
}

// Watch lists still sending their objects at openingHoldFor (a big list on a slow link) are no sign of a missing
// bookmark: the cluster goes on asking for watch lists.
func TestWatchListsStillSendingAtOpeningHoldForKeepTheWatchList(t *testing.T) {
	api := &chanAPI{objects: 300, gap: 2 * time.Millisecond}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.openingHoldFor = 50 * time.Millisecond
	ctx := testCtx(t)
	for i := 0; i <= noBookmarkCaps; i++ {
		out := make(chan *ResponseMessage, 16)
		go drain(ctx, out)
		go chanWatch(ctx, m, "alpha", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
	}
	eventually(t, "the watch lists to start", 5*time.Second, func() bool { return len(api.options()) == noBookmarkCaps+1 })
	time.Sleep(200 * time.Millisecond) // past openingHoldFor, before the bookmarks
	m.mu.Lock()
	strikes := m.noBookmark["alpha"]
	_, refused := m.noWatchList["alpha"]
	m.mu.Unlock()
	if strikes != 0 || refused {
		t.Errorf("watch lists still sending at openingHoldFor counted %d missing bookmarks (refused %v), want none", strikes, refused)
	}
}

// A pause of a few tens of milliseconds in the objects of a watch served the earlier way does not end its opening:
// with one place of the cluster's share, no second watch reads its objects meanwhile.
func TestAShortPauseDoesNotEndAnOpeningOfTheEarlierWay(t *testing.T) {
	api := &chanAPI{objects: 20, stallAt: 10, stall: 30 * time.Millisecond, refuse: true}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.MaxWatchOpenings = 1
	ctx := testCtx(t)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan *ResponseMessage, 64)
			go chanWatch(ctx, m, "alpha", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
			for frames, deadline := 0, time.After(10*time.Second); frames < api.objects; {
				select {
				case f := <-out:
					if f.Type == "DATA" {
						frames++
					}
				case <-deadline:
					return
				}
			}
		}()
	}
	wg.Wait()
	if got := api.mostAtOnce(); got != 1 {
		t.Errorf("%d watches read at once with a 30 ms pause in their objects, want 1", got)
	}
}

// A cluster that refused watch lists is asked again after watchListRetry: an upgrade or a feature gate turned on may
// change the answer.
func TestAClusterThatRefusedWatchListsIsAskedAgainLater(t *testing.T) {
	api := &chanAPI{objects: 1, refuse: true}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.watchListRetry = 200 * time.Millisecond
	ctx := testCtx(t)
	open := func(name string) {
		out := make(chan *ResponseMessage, 16)
		go chanWatch(ctx, m, "alpha", "watch=1&labelSelector=a%3D"+name, out)
		if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
			t.Fatalf("watch %s: %q, want DATA", name, typ)
		}
	}
	watchLists := func() (n int) {
		for _, o := range api.options() {
			if o.SendInitialEvents != nil {
				n++
			}
		}
		return n
	}
	open("first")
	open("soon")
	if n := watchLists(); n != 1 {
		t.Fatalf("asked for a watch list %d times before watchListRetry, want once", n)
	}
	time.Sleep(250 * time.Millisecond)
	open("later")
	if n := watchLists(); n != 2 {
		t.Errorf("asked for a watch list %d times after watchListRetry, want twice", n)
	}
}

// A browser that reads slowly gives its opening place back and its watch waits with at most WatchStreamWindow of its
// list unread (HTTP/2 flow control): 16 slow browsers opening lists of 2 000 objects of 4 KB over TLS took the live
// heap 66.8 MiB up on 70c842dc, Go's 4 MiB window a stream.
func TestSlowBrowsersHoldLittleOfTheirLists(t *testing.T) {
	pad := strings.Repeat("p", 4000)
	var h2 atomic.Int64
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor == 2 {
			h2.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i < 2000 && r.Context().Err() == nil; i++ {
			fmt.Fprintf(w, `{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"web-%d","namespace":"demo","resourceVersion":"%d","annotations":{"pad":%q}},"spec":{"containers":[]},"status":{"phase":"Running"}}}`+"\n", i, 10+i, pad)
			if i%50 == 0 {
				w.(http.Flusher).Flush()
			}
		}
		endInitialEvents(w, r, "v1", "Pod", "5000")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1, TLSClientConfig: rest.TLSClientConfig{Insecure: true}}
	d, err := dynamic.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m := NewMultiplexer(configClients{fakeClients{d}, cfg})
	m.MaxWatchOpenings = 2
	m.WatchStreamWindow = 256 << 10
	m.heap = func() (uint64, uint64) { return 0, 0 }
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		srv.CloseClientConnections()
	}()
	before := liveHeap()
	for i := 0; i < 16; i++ {
		out := make(chan *ResponseMessage, 4)
		go func() {
			for {
				select {
				case <-out:
					time.Sleep(20 * time.Millisecond)
				case <-ctx.Done():
					return
				}
			}
		}()
		go watchInto(ctx, m, "/api/v1/pods", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
	}
	eventually(t, "the 16 watches to reach the API server over HTTP/2", 20*time.Second, func() bool { return h2.Load() == 16 })
	time.Sleep(2 * time.Second) // each stream's window fills
	grown := (float64(liveHeap()) - float64(before)) / (1 << 20)
	t.Logf("16 slow browsers: live heap +%.1f MiB 2 s after their watches started, HTTP/2 requests %d", grown, h2.Load())
	if grown > 16 {
		t.Errorf("16 slow browsers' watches took the live heap %.1f MiB up, want at most 16 (16 windows of 256 KiB are 4)", grown)
	}
}

func liveHeap() uint64 {
	runtime.GC()
	s := []metrics.Sample{{Name: "/gc/heap/live:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64()
}

// A server with one cluster opens as many lists at once as it has places: the half a cluster may hold applies only
// while another cluster waits. On cb3c5515 (review probe P-D) 64 openings of 0.2 s took 4.05 s with 8 places, at most
// 4 at once.
func TestOneClusterOpensWithEveryPlace(t *testing.T) {
	api := &chanAPI{objects: 20, gap: 2 * time.Millisecond}
	m := NewMultiplexer(chanClusters{"alpha": api})
	m.MaxWatchOpenings = 4
	ctx := testCtx(t)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan *ResponseMessage, 64)
			go chanWatch(ctx, m, "alpha", fmt.Sprintf("watch=1&labelSelector=a%%3D%d", i), out)
			for frames, deadline := 0, time.After(20*time.Second); frames < api.objects; {
				select {
				case f := <-out:
					if f.Type == "DATA" {
						frames++
					}
				case <-deadline:
					return
				}
			}
		}()
	}
	wg.Wait()
	t.Logf("one cluster, 4 places: %d read at once", api.mostAtOnce())
	if got := api.mostAtOnce(); got != 4 {
		t.Errorf("%d watches of the only cluster were read at once, want the 4 places", got)
	}
}

// A watch from no version takes its opening place before it starts: while another cluster holds every place it asks
// its API server nothing, so no answered watch waits unread for a place (the API server closes a watch it cannot
// write to past 100 ms).
func TestAnOpeningTakesItsPlaceBeforeItsStart(t *testing.T) {
	api := &chanAPI{objects: 1}
	m := NewMultiplexer(chanClusters{"alpha": api})
	places := m.openingPlaces()
	places.setAnswering("other", true)
	held := make([]func(), 0, places.Cap())
	for i := 0; i < places.Cap(); i++ {
		held = append(held, takeNow(t, places, "other"))
	}
	ctx := testCtx(t)
	out := make(chan *ResponseMessage, 8)
	go chanWatch(ctx, m, "alpha", "watch=1", out)
	time.Sleep(100 * time.Millisecond)
	if n := len(api.options()); n != 0 {
		t.Fatalf("the API server was asked %d watches while every place was taken, want none", n)
	}
	held[0]()
	if typ := firstFrame(out, 5*time.Second); typ != "DATA" {
		t.Fatalf("once a place came back: %q, want DATA", typ)
	}
	for _, give := range held[1:] {
		give()
	}
}

// A watch whose context ends while it waits for a place, or while it holds one for a start the API server has not
// answered, gives it back: no place or turn is kept for a socket that has gone.
func TestAWatchWhoseContextEndsGivesItsPlaceBack(t *testing.T) {
	dead := &chanAPI{hang: true}
	m := NewMultiplexer(chanClusters{"dead": dead})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			chanWatch(ctx, m, "dead", fmt.Sprintf("watch=1&labelSelector=d%%3D%d", i), make(chan *ResponseMessage, 8))
			done <- struct{}{}
		}()
	}
	q := m.openingPlaces()
	eventually(t, "one watch starting and one waiting", 5*time.Second, func() bool { return q.InUse() == 1 && q.waiters() == 1 })
	cancel()
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("a watch did not end with its context")
		}
	}
	if n, w := q.InUse(), q.waiters(); n != 0 || w != 0 {
		t.Errorf("%d places in use and %d waiting after the sockets went, want none", n, w)
	}
}
