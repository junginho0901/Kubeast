package ws

import (
	"encoding/json"
	"math"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// A new watch waits while the heap the last collection found live is past watchMemoryShare of the collector's limit,
// with the limit frame the page already asks again after (limit_scope "memory"); the watches already on go on.
func TestANewWatchWaitsWhileTheLiveHeapIsPastItsShare(t *testing.T) {
	var live atomic.Uint64
	m := muxOn(t, eventThenHold)
	m.heap = func() (uint64, uint64) { return live.Load(), 1000 }
	conn := socketTo(t, m, everyCluster)

	live.Store(750) // at the share, not past it
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("a watch under the share: %s, want DATA", f.Type)
	}

	live.Store(751)
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1&labelSelector=a%3D1")
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var refused struct {
		Type  string            `json:"type"`
		Query string            `json:"query"`
		Error map[string]string `json:"error"`
	}
	if err := json.Unmarshal(raw, &refused); err != nil {
		t.Fatal(err)
	}
	if refused.Type != "ERROR" || refused.Error["reason"] != reasonLimit || refused.Error["limit_scope"] != limitScopeMemory || refused.Query != "watch=1&labelSelector=a%3D1" {
		t.Fatalf("a watch past the share got %s", raw)
	}
	if n := m.SubscriptionCount(); n != 1 {
		t.Errorf("live subscriptions = %d, want the first one still on", n)
	}

	live.Store(100)
	request(t, conn, "REQUEST", "default", "/api/v1/pods", "watch=1&labelSelector=a%3D1")
	if f := nextFrame(t, conn); f.Type != "DATA" || f.Query != "watch=1&labelSelector=a%3D1" {
		t.Fatalf("the same watch asked again with room: %s %s, want DATA", f.Type, f.Query)
	}
	if n := m.SubscriptionCount(); n != 2 {
		t.Errorf("live subscriptions = %d, want 2", n)
	}
}

// Without a limit (GOMEMLIMIT unset outside a container: the largest int64) no heap makes a watch wait.
func TestNoWatchWaitsWithoutAMemoryLimit(t *testing.T) {
	m := NewMultiplexer(fakeClients{})
	for _, limit := range []uint64{0, math.MaxInt64} {
		m.heap = func() (uint64, uint64) { return 1 << 40, limit }
		if m.watchMemoryFull() {
			t.Errorf("limit %d: a watch waits", limit)
		}
	}
	m.heap = func() (uint64, uint64) { return 1 << 30, 1 << 30 }
	if !m.watchMemoryFull() {
		t.Error("a heap at the limit lets a watch open")
	}
}

// The heap is read from runtime/metrics at most once a second, whatever the number of REQUESTs.
func TestTheHeapIsReadAtMostOnceASecond(t *testing.T) {
	runtime.GC()
	var h heapReading
	live, limit := h.read()
	if live == 0 || limit == 0 {
		t.Fatalf("read live %d, limit %d: want both from runtime/metrics", live, limit)
	}
	h.live = 1
	if again, _ := h.read(); again != 1 {
		t.Errorf("read again within the second: %d, want the reading kept", again)
	}
	h.at = time.Now().Add(-time.Second)
	if again, _ := h.read(); again == 1 {
		t.Error("read after a second: the old reading kept")
	}
}
