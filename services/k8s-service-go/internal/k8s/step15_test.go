package k8s

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestClusterHealthBreaker(t *testing.T) {
	h := newClusterHealth(3, time.Minute) // open after 3 consecutive live failures
	const id cluster.ID = "c1"

	if h.isOpen(id) {
		t.Fatal("a never-seen cluster must start closed")
	}
	h.recordFailure(id)
	h.recordFailure(id)
	if h.isOpen(id) {
		t.Fatal("breaker opened before the threshold (2 < 3)")
	}
	h.recordFailure(id)
	if !h.isOpen(id) {
		t.Fatal("breaker must open at the threshold (3)")
	}
	h.recordSuccess(id)
	if h.isOpen(id) {
		t.Fatal("a single success must close the breaker")
	}
	// health-check verdict opens immediately regardless of threshold
	h.setOpen(id, true)
	if !h.isOpen(id) {
		t.Fatal("setOpen(true) must open immediately")
	}
	h.setOpen(id, false)
	if h.isOpen(id) {
		t.Fatal("setOpen(false) must close")
	}
}

// Open for its period the breaker refuses every request; then one request at a time tries the cluster, holding the
// next period. Its success closes the breaker, its failure opens it for another period from then.
func TestAnOpenBreakerLetsOneRequestTryTheClusterAfterItsPeriod(t *testing.T) {
	const id cluster.ID = "c1"
	const period = 30 * time.Second
	h := newClusterHealth(5, period)
	at := time.Unix(1_000_000, 0)
	h.now = func() time.Time { return at }
	tryAll := func(n int) (admitted int) {
		var wg sync.WaitGroup
		var got atomic.Int32
		for range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if ok, _ := h.admit(id); ok {
					got.Add(1)
				}
			}()
		}
		wg.Wait()
		return int(got.Load())
	}

	h.setOpen(id, true)
	if n := tryAll(20); n != 0 {
		t.Fatalf("%d requests let through right after opening", n)
	}
	at = at.Add(period - time.Second)
	if n := tryAll(20); n != 0 {
		t.Fatalf("%d requests let through before the period ended", n)
	}
	at = at.Add(time.Second)
	if n := tryAll(20); n != 1 {
		t.Fatalf("%d requests let through once the period ended, want one", n)
	}
	at = at.Add(period - time.Second)
	if n := tryAll(20); n != 0 {
		t.Fatalf("%d more let through while the one trying holds its period", n)
	}
	h.recordFailure(id) // the request trying it failed
	at = at.Add(period - time.Second)
	if n := tryAll(20); n != 0 {
		t.Fatalf("%d let through within a period of the failed try", n)
	}
	at = at.Add(time.Second)
	if n := tryAll(20); n != 1 {
		t.Fatalf("%d let through a period after the failed try, want one", n)
	}
	h.recordSuccess(id)
	if n := tryAll(20); n != 20 || h.isOpen(id) {
		t.Fatalf("%d of 20 let through after the try succeeded, open %v: want closed", n, h.isOpen(id))
	}
	// a try that gave no answer (a reply of Kubeast's own) holds its period; after it the next request tries
	h.setOpen(id, true)
	at = at.Add(period)
	if n := tryAll(20); n != 1 {
		t.Fatalf("%d let through, want one", n)
	}
	at = at.Add(period)
	if n := tryAll(20); n != 1 {
		t.Fatalf("%d let through a period after a try with no answer, want one", n)
	}
	// a trial the cluster did not answer gives its try to the next request, and only its own booking
	at = at.Add(period)
	ok, booked := h.admit(id)
	if !ok || booked.IsZero() {
		t.Fatalf("a period after the last try: let through %v, booked until %v", ok, booked)
	}
	h.unbook(id, booked.Add(-time.Second))
	if n := tryAll(20); n != 0 {
		t.Fatalf("%d let through after another booking was given back", n)
	}
	h.unbook(id, booked)
	if n := tryAll(20); n != 1 || !h.isOpen(id) {
		t.Fatalf("%d let through after the trial gave its try back (open %v), want one and still open", n, h.isOpen(id))
	}
	if newClusterHealth(5, 0).openFor != defaultBreakerOpen {
		t.Error("no period given is not the default")
	}
}

func TestClusterLimiters(t *testing.T) {
	// qps<=0 disables limiting entirely.
	if !newClusterLimiters(0, 0).Allow("x") {
		t.Fatal("disabled limiter must always allow")
	}

	// burst=3 → first 3 immediate requests pass, the 4th is throttled.
	l := newClusterLimiters(1, 3)
	for i := 0; i < 3; i++ {
		if !l.Allow("c1") {
			t.Fatalf("request %d within burst should pass", i+1)
		}
	}
	if l.Allow("c1") {
		t.Fatal("request beyond burst should be throttled")
	}
	// a different cluster has its own bucket (isolation)
	if !l.Allow("c2") {
		t.Fatal("a different cluster must not be affected by c1's limit")
	}
}

func TestPromQueryCacheSingleflight(t *testing.T) {
	c := newPromQueryCache(time.Minute)
	var calls int32
	start := make(chan struct{})
	var wg sync.WaitGroup
	fetch := func() ([]map[string]interface{}, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(20 * time.Millisecond) // hold the flight so others coalesce
		return []map[string]interface{}{{"v": 1}}, nil
	}
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := c.do("k", fetch); err != nil {
				t.Errorf("do: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("10 concurrent identical queries hit the backend %d times, want 1 (singleflight)", n)
	}
	// within TTL the next call is served from cache (no extra fetch)
	if _, err := c.do("k", fetch); err != nil {
		t.Fatalf("cached do: %v", err)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("cached call refetched (calls=%d, want 1)", n)
	}
}

func TestPromQueryCacheTTLExpiry(t *testing.T) {
	c := newPromQueryCache(20 * time.Millisecond)
	var calls int32
	fetch := func() ([]map[string]interface{}, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}
	_, _ = c.do("k", fetch)
	time.Sleep(40 * time.Millisecond) // let the entry expire
	_, _ = c.do("k", fetch)
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("expected a refetch after TTL expiry (calls=%d, want 2)", n)
	}
}

func TestPromQueryCacheDisabledTTL(t *testing.T) {
	c := newPromQueryCache(0) // ttl 0 → no caching, but singleflight still dedups
	var calls int32
	fetch := func() ([]map[string]interface{}, error) {
		atomic.AddInt32(&calls, 1)
		return nil, nil
	}
	_, _ = c.do("k", fetch)
	_, _ = c.do("k", fetch)
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("ttl=0 must not cache between sequential calls (calls=%d, want 2)", n)
	}
}
