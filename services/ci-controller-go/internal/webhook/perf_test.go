package webhook

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	tb.Helper()
	h := &Handler{
		Verifier:   verifier(tb),
		Deliveries: NewDeliveries(),
		Enqueue:    func(Event) bool { return true },
		Now:        func() time.Time { return time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC) },
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
