package k8s

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestClusterHealthBreaker(t *testing.T) {
	h := newClusterHealth(3) // open after 3 consecutive live failures
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
