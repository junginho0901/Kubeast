package handler

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// sweptRows is the registry side of a health checker on the cluster c1: it lists c1 and hands on each status written.
type sweptRows struct{ written chan string }

func (sweptRows) ListMeta(context.Context) ([]cluster.Meta, error) {
	return []cluster.Meta{{ID: "c1"}}, nil
}

func (r sweptRows) UpdateHealth(_ context.Context, _ cluster.ID, status string) error {
	r.written <- status
	return nil
}

// With the people's requests to c1 queued past a probe's 5 s in its client's rate (one a second), the health check
// still finds c1's API server answering, and the next screen of c1 is let through, not answered 503 "currently
// unreachable" (before, the probe waited in that queue, its time ended there and the breaker opened).
func TestAHealthCheckDuringALongQueueLeavesTheScreensOpen(t *testing.T) {
	h, hits := countedBreakerHandler(t, k8s.ServiceOptions{BreakerFails: 5, ClientQPS: 1, ClientBurst: 1})
	crowd, leave := context.WithCancel(cluster.WithID(context.Background(), "c1"))
	var wg sync.WaitGroup
	defer func() { leave(); wg.Wait() }()
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = h.svc.RawRequest(crowd, http.MethodGet, "/version")
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond) // the other eleven are in the queue; the next token comes a second after the first
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d of the people's requests reached the API server, want the first only", n)
	}

	written := make(chan string, 1)
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		k8s.NewHealthChecker(h.svc, sweptRows{written: written}, time.Hour).Run(ctx)
	}()
	defer func() { stop(); <-done }()
	var status string
	select {
	case status = <-written:
	case <-time.After(10 * time.Second):
		t.Fatal("the health check wrote no status within 10 s")
	}
	rec := askC1(h, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	if status != "healthy" || rec.Code != http.StatusOK {
		t.Errorf("after a health check with the queue long: written %q, the next screen %d %s; want healthy and 200",
			status, rec.Code, rec.Body.String())
	}
}
