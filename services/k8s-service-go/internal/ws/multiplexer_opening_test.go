package ws

import (
	"context"
	"fmt"
	"net/http"
	"runtime"
	"runtime/metrics"
	"sync"
	"testing"
	"time"
)

// openingWatches is an API server whose watches send their objects one after another as they open, as a watch from no
// version does, and then stay quiet; it counts the watches that are sending their objects at once.
type openingWatches struct {
	objects int
	gap     time.Duration

	mu            sync.Mutex
	sending, most int
}

func (s *openingWatches) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
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
	<-r.Context().Done()
}

func (s *openingWatches) mostAtOnce() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.most
}

// A watch from no version sends every object there is as it opens, and the watches of a restart all open at once: each
// keeps its start place until its objects are through, so a crowd's openings come a few at a time and every object
// still reaches every list. At 700 people the openings after a restart took k8s-service from 121 to 285 MiB of live
// heap in two seconds while the places went back at each watch's first answer.
func TestWatchesOfAClusterOpenAFewAtATime(t *testing.T) {
	api := &openingWatches{objects: 20, gap: 2 * time.Millisecond}
	m := muxOn(t, api.serve)
	m.MaxWatchStarts = 4
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const subscriptions = 32
	var wg sync.WaitGroup
	frames := make([]int, subscriptions)
	for i := range frames {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out := make(chan *ResponseMessage, 4)
			go watchInto(ctx, m, "/api/v1/pods", "watch=1", out)
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
	t.Logf("watches sending their objects at once: %d, for %d subscriptions and %d places", api.mostAtOnce(), subscriptions, m.MaxWatchStarts)
	if got := api.mostAtOnce(); got > m.MaxWatchStarts {
		t.Errorf("%d watches sent their objects at once, want at most the %d places", got, m.MaxWatchStarts)
	}
}

// An opening that does not end within startHoldFor, on a list that keeps changing, gives its place back then.
func TestAnOpeningThatGoesOnGivesItsPlaceBackAfterAWhile(t *testing.T) {
	api := &openingWatches{objects: 400, gap: 5 * time.Millisecond}
	m := muxOn(t, api.serve)
	m.MaxWatchStarts = 1
	m.startHoldFor = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	drain := func(out chan *ResponseMessage) {
		for {
			select {
			case <-out:
			case <-ctx.Done():
				return
			}
		}
	}
	first, second := make(chan *ResponseMessage, 4), make(chan *ResponseMessage, 4)
	go drain(first)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1", first)
	time.Sleep(20 * time.Millisecond)
	go watchInto(ctx, m, "/api/v1/pods", "watch=1&labelSelector=a%3D1", second)
	select {
	case f := <-second:
		if f.Type != "DATA" {
			t.Fatalf("the second list: %s, want DATA", f.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("the second watch waited for an opening of two seconds")
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
	go func() {
		defer close(done)
		watchInto(context.Background(), m, "/api/v1/pods", "watch=1", out)
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
	if n := m.watchStartPlaces("default").InUse(); n != 0 {
		t.Errorf("%d places still taken", n)
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
