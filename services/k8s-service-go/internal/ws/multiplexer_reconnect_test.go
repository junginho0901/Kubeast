package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// startingWatches counts the watches an API server is answering right now, before its first byte of each.
type startingWatches struct {
	delay time.Duration

	mu             sync.Mutex
	starting, most int
	started        int
}

func (s *startingWatches) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.started++
	s.starting++
	if s.starting > s.most {
		s.most = s.starting
	}
	s.mu.Unlock()
	time.Sleep(s.delay)
	s.mu.Lock()
	s.starting--
	s.mu.Unlock()
	eventThenHold(w, r)
}

func (s *startingWatches) mostAtOnce() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.most
}

func (s *startingWatches) startedSoFar() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// When every subscription has to come back at once (the API server restarted, k8s-service restarted) they start a few
// at a time, and all of them do start.
func TestWatchesOfAClusterStartAFewAtATimeAndAllStart(t *testing.T) {
	api := &startingWatches{delay: 30 * time.Millisecond}
	m := muxOn(t, api.serve)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const subscriptions = 128
	var wg sync.WaitGroup
	got := make(chan string, subscriptions)
	for i := 0; i < subscriptions; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan ResponseMessage, 4)
			go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
			select {
			case f := <-out:
				got <- f.Type
			case <-time.After(30 * time.Second):
				got <- "nothing"
			}
		}()
	}
	wg.Wait()
	close(got)
	data := 0
	for typ := range got {
		if typ == "DATA" {
			data++
		}
	}
	t.Logf("watches starting at once: %d, for %d subscriptions", api.mostAtOnce(), subscriptions)
	if data != subscriptions {
		t.Errorf("%d of %d subscriptions got their first frame", data, subscriptions)
	}
	if got := api.mostAtOnce(); got > defaultWatchStartsAtOnce {
		t.Errorf("%d watches started at once, want at most %d", got, defaultWatchStartsAtOnce)
	}
}

// Waiting for a turn holds one parked goroutine per subscription, reaches no API server and sends nothing; a
// subscription closed while waiting goes at once.
func TestWatchesWaitingForATurnHoldLittleAndLeaveWhenClosed(t *testing.T) {
	api := &startingWatches{}
	m := muxOn(t, api.serve)
	places := m.watchStartPlaces("default")
	held := make([]func(), 0, places.Cap())
	for i := 0; i < places.Cap(); i++ {
		release, err := places.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const waiting = 500
	out := make(chan ResponseMessage, 1)
	var done sync.WaitGroup
	for i := 0; i < waiting; i++ {
		done.Add(1)
		go func() {
			defer done.Done()
			watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
		}()
	}
	time.Sleep(100 * time.Millisecond)
	runtime.GC()
	runtime.ReadMemStats(&after)
	perWatch := (int64(after.HeapAlloc) + int64(after.StackInuse) - int64(before.HeapAlloc) - int64(before.StackInuse)) / waiting
	t.Logf("memory per waiting subscription: %d bytes", perWatch)
	if perWatch > 32<<10 {
		t.Errorf("a waiting subscription holds %d bytes", perWatch)
	}
	if got := api.startedSoFar(); got != 0 {
		t.Errorf("%d watches reached the API server with every place taken", got)
	}
	if len(out) != 0 {
		t.Errorf("%d frames queued by waiting subscriptions", len(out))
	}

	cancel()
	ended := make(chan struct{})
	go func() { done.Wait(); close(ended) }()
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("subscriptions closed while waiting did not end")
	}
	for _, release := range held {
		release()
	}
	if n := places.InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
	}
}

// A list whose watch waits long for a turn is not following: its page is told, as with a watch that failed, once, and
// reads its list again when the watch is on.
func TestALongWaitForATurnIsSaidAndTheListIsReadAgain(t *testing.T) {
	m := muxOn(t, eventThenHold)
	m.startNoticeAfter = 20 * time.Millisecond
	places := m.watchStartPlaces("default")
	held := make([]func(), 0, places.Cap())
	for i := 0; i < places.Cap(); i++ {
		release, err := places.Take(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan ResponseMessage, 8)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
	f := <-out
	data, _ := f.Error.(map[string]string)
	if f.Type != "ERROR" || data["reason"] != reasonUnreachable {
		t.Fatalf("after the long wait: %s %v", f.Type, f.Error)
	}
	for _, release := range held {
		release()
	}
	if f := <-out; f.Type != "RESYNC" {
		t.Fatalf("when its turn came: %s, want RESYNC", f.Type)
	}
	if f := <-out; f.Type != "DATA" {
		t.Fatalf("then %s, want DATA", f.Type)
	}
}

// An API server that does not answer a start does not stop the queue behind it for long.
func TestAStartThatHangsGivesUpItsPlaceAfterAWhile(t *testing.T) {
	var reached atomic.Int64
	release := make(chan struct{})
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	m.startHoldFor = 20 * time.Millisecond
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	want := int64(defaultWatchStartsAtOnce + 4)
	for i := int64(0); i < want; i++ {
		go watchInto(ctx, m, "/api/v1/pods", "watch=1", make(chan ResponseMessage, 4))
	}
	deadline := time.Now().Add(5 * time.Second)
	for reached.Load() < want {
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d starts reached the API server behind ones that hang", reached.Load(), want)
		}
		time.Sleep(time.Millisecond)
	}
}

// A failed watch tries again about five seconds later, each at its own moment.
func TestWatchRetriesAreSpreadAroundFiveSeconds(t *testing.T) {
	least, most := time.Hour, time.Duration(0)
	for i := 0; i < 2000; i++ {
		d := watchRetryDelay()
		least, most = min(least, d), max(most, d)
	}
	t.Logf("retry delay between %v and %v", least, most)
	if least < 3*time.Second || most > 7*time.Second {
		t.Errorf("retry delay between %v and %v, want 3s to 7s", least, most)
	}
	if most-least < 3*time.Second {
		t.Errorf("retries spread over %v only", most-least)
	}
}

// A watch that ended by itself comes back about a second later, each at its own moment.
func TestWatchesBackFromAnEndAreSpreadAroundASecond(t *testing.T) {
	least, most := time.Hour, time.Duration(0)
	for i := 0; i < 2000; i++ {
		d := watchResumeDelay()
		least, most = min(least, d), max(most, d)
	}
	t.Logf("resume delay between %v and %v", least, most)
	if least < 500*time.Millisecond || most > 1500*time.Millisecond {
		t.Errorf("resume delay between %v and %v, want 0.5s to 1.5s", least, most)
	}
	if most-least < 500*time.Millisecond {
		t.Errorf("resumes spread over %v only", most-least)
	}
}

// Watches started together do not all end together five minutes later.
func TestWatchesStartedTogetherDoNotEndTogether(t *testing.T) {
	var mu sync.Mutex
	seen := map[int]bool{}
	var asks atomic.Int64
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("timeoutSeconds"))
		mu.Lock()
		seen[n] = true
		mu.Unlock()
		asks.Add(1)
		eventThenHold(w, r)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := 0; i < 64; i++ {
		go watchInto(ctx, m, "/api/v1/pods", "watch=1", make(chan ResponseMessage, 4))
	}
	deadline := time.Now().Add(5 * time.Second)
	for asks.Load() < 64 {
		if time.Now().After(deadline) {
			t.Fatalf("%d of 64 watches started", asks.Load())
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Logf("%d different timeouts among 64 watches", len(seen))
	if len(seen) < 10 {
		t.Errorf("only %d different timeouts among 64 watches", len(seen))
	}
	for n := range seen {
		if n < 270 || n > 330 {
			t.Errorf("a watch asked for %d seconds, want about five minutes", n)
		}
	}
}

// Each cluster has its own places: a cluster that is slow to start watches does not hold up another.
func TestAClustersWatchStartsDoNotWaitForAnothers(t *testing.T) {
	m := muxOn(t, eventThenHold)
	busy := m.watchStartPlaces("busy")
	for i := 0; i < busy.Cap(); i++ {
		if _, err := busy.Take(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	other := m.watchStartPlaces("other")
	if other == busy || other.InUse() != 0 {
		t.Fatalf("clusters share places: %d taken", other.InUse())
	}
	if m.watchStartPlaces("busy") != busy {
		t.Fatal("a cluster's places are not kept")
	}
}

// The frame that says a watch was refused for a limit says which: closing a tab frees the one, not the other.
func TestALimitFrameSaysWhichLimit(t *testing.T) {
	limitScope := func(raw []byte) string {
		var v struct {
			Error map[string]string `json:"error"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		if v.Error["reason"] != reasonLimit {
			t.Fatalf("reason = %q, want %q", v.Error["reason"], reasonLimit)
		}
		return v.Error["limit_scope"]
	}

	m := muxOn(t, eventThenHold)
	m.MaxSubscriptionsPerConn = 1
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("first watch: %s", f.Type)
	}
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1&labelSelector=a%3D1")
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if got := limitScope(raw); got != limitScopeTab {
		t.Errorf("the tab's limit says %q, want %q", got, limitScopeTab)
	}

	all := muxOn(t, eventThenHold)
	all.MaxSubscriptions = 1
	first, second := socketTo(t, all, everyCluster), socketTo(t, all, everyCluster)
	request(t, first, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, first); f.Type != "DATA" {
		t.Fatalf("first watch: %s", f.Type)
	}
	request(t, second, "REQUEST", "default", "/api/v1/pods", "watch=1")
	_, raw, err = second.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if got := limitScope(raw); got != limitScopeServer {
		t.Errorf("the server's limit says %q, want %q", got, limitScopeServer)
	}
}
