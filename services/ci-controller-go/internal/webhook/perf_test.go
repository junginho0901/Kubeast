package webhook

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

// maxDeliveryAllocs caps the allocations of answering one push delivery
// (read, check the signature, parse, take the ID, queue), about a fifth
// above what it takes now: 61 on Go 1.26.0, the version the CI go job reads
// from go.mod, and 49 on Go 1.27 (the test's own request included in both).
// The CI design's pass line is 200 ms at p95 for the answer; time is
// measured by the benchmark when nothing else runs.
const maxDeliveryAllocs = 75

func deliveryLoop(tb testing.TB) (func(), *Handler) {
	return deliveryLoopFrom(tb, nil, "")
}

// deliveryLoopFrom sends from remote (host:port, httptest's own when empty)
// to a handler that checks the source against ranges when it is set.
func deliveryLoopFrom(tb testing.TB, ranges *Ranges, remote string) (func(), *Handler) {
	tb.Helper()
	h := &Handler{
		Verifier:   verifier(tb),
		Deliveries: NewDeliveries(),
		Enqueue:    func(Event) bool { return true },
		Now:        func() time.Time { return time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC) },
		Ranges:     ranges,
	}
	body := payload(tb, "push_with-new-branch.payload.json")
	sig := sign(testSecret, body)
	n := 0
	return func() {
		n++
		r := httptest.NewRequest(http.MethodPost, Path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-GitHub-Event", "push")
		r.Header.Set("X-GitHub-Delivery", fmt.Sprintf("bench-%d", n))
		r.Header.Set("X-Hub-Signature-256", sig)
		if remote != "" {
			r.RemoteAddr = remote
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusAccepted {
			tb.Fatalf("answer %d", w.Code)
		}
	}, h
}

func TestDeliveryAllocs(t *testing.T) {
	one, _ := deliveryLoop(t)
	allocs := testing.AllocsPerRun(100, one)
	t.Logf("one push delivery: %.0f allocations (cap %d)", allocs, maxDeliveryAllocs)
	if allocs > maxDeliveryAllocs {
		t.Fatalf("one push delivery took %.0f allocations, the cap is %d", allocs, maxDeliveryAllocs)
	}
}

func BenchmarkDelivery(b *testing.B) {
	one, _ := deliveryLoop(b)
	b.ReportAllocs()
	for b.Loop() {
		one()
	}
}

// loadedRanges is GitHub's /meta answer of 2026-11-01 (nine hook ranges),
// read once.
func loadedRanges(tb testing.TB) *Ranges {
	tb.Helper()
	_, r := newMeta(tb)
	if _, err := r.Refresh(context.Background()); err != nil {
		tb.Fatal(err)
	}
	return r
}

// TestDeliveryWithRangesAllocs: checking the source against the /meta list
// adds no allocation, so the same cap holds.
func TestDeliveryWithRangesAllocs(t *testing.T) {
	one, _ := deliveryLoopFrom(t, loadedRanges(t), "[2606:50c0::1]:443")
	allocs := testing.AllocsPerRun(100, one)
	t.Logf("one push delivery from a /meta range: %.0f allocations (cap %d)", allocs, maxDeliveryAllocs)
	if allocs > maxDeliveryAllocs {
		t.Fatalf("one push delivery took %.0f allocations, the cap is %d", allocs, maxDeliveryAllocs)
	}
}

func TestRangesContainsAllocs(t *testing.T) {
	r := loadedRanges(t)
	addr := netip.MustParseAddr("::ffff:203.0.113.9") // mapped, outside: every range is tried
	if n := testing.AllocsPerRun(100, func() { r.Contains(addr) }); n != 0 {
		t.Fatalf("Contains allocated %.0f times", n)
	}
}

// BenchmarkDeliveryWithRanges is BenchmarkDelivery from the last of the
// nine ranges, IPv6.
func BenchmarkDeliveryWithRanges(b *testing.B) {
	one, _ := deliveryLoopFrom(b, loadedRanges(b), "[2606:50c0::1]:443")
	b.ReportAllocs()
	for b.Loop() {
		one()
	}
}

// BenchmarkRangesContains is the worst case: an address in no range.
func BenchmarkRangesContains(b *testing.B) {
	r := loadedRanges(b)
	addr := netip.MustParseAddr("::ffff:203.0.113.9")
	b.ReportAllocs()
	for b.Loop() {
		if r.Contains(addr) {
			b.Fatal("inside")
		}
	}
}
