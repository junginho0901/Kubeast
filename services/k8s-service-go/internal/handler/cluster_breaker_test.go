package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func breakerHandler(t *testing.T, opts k8s.ServiceOptions) *Handler {
	t.Helper()
	svc, err := k8s.NewService(context.Background(), middlewareRegistry{}, false, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{svc: svc, auditStore: &memAudit{}}
}

// askKnown sends one request for the cluster "known" through ClusterMiddleware to next and gives the status.
func askKnown(h *Handler, next http.HandlerFunc) int {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/cluster/overview?cluster=known", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}))
	rec := httptest.NewRecorder()
	h.ClusterMiddleware(next).ServeHTTP(rec, req)
	return rec.Code
}

// An open cluster fails fast for MC_BREAKER_OPEN_SEC; then one request goes to the cluster while the others still fail
// fast. Its success closes the breaker, so a screen's own request brings the cluster back; its failure opens it again.
func TestAnOpenClusterIsTriedByOneRequestAfterItsPeriod(t *testing.T) {
	const period = time.Second
	h := breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})
	reached := 0
	fail := func(w http.ResponseWriter, _ *http.Request) {
		reached++
		h.handleError(w, errors.New("dial tcp 10.0.0.9:6443: connect: connection refused"))
	}
	ok := func(w http.ResponseWriter, _ *http.Request) { reached++; w.WriteHeader(http.StatusOK) }
	openIt := func() {
		t.Helper()
		if code := askKnown(h, fail); code != http.StatusServiceUnavailable || !h.svc.ClusterDown("known") {
			t.Fatalf("a failed call to the cluster: %d, open %v", code, h.svc.ClusterDown("known"))
		}
		reached = 0
		if code := askKnown(h, ok); code != http.StatusServiceUnavailable || reached != 0 {
			t.Fatalf("right after it opened: %d with the handler run %d times, want a fast 503", code, reached)
		}
	}

	openIt()
	time.Sleep(period + 50*time.Millisecond)
	release := make(chan struct{})
	var entered atomic.Int32
	waitAtCluster := func(w http.ResponseWriter, _ *http.Request) {
		entered.Add(1)
		<-release
		w.WriteHeader(http.StatusOK)
	}
	codes := make(chan int, 8)
	for range 8 {
		go func() { codes <- askKnown(h, waitAtCluster) }()
	}
	for i := range 7 {
		select {
		case code := <-codes:
			if code != http.StatusServiceUnavailable {
				t.Errorf("a request beside the one trying the cluster: %d, want a fast 503", code)
			}
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatalf("%d of 8 answered while %d requests waited at the cluster, want 7 and one", i, entered.Load())
		}
	}
	for deadline := time.Now().Add(5 * time.Second); entered.Load() == 0 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if n := entered.Load(); n != 1 {
		t.Errorf("%d requests reached the cluster once the period ended, want one", n)
	}
	close(release)
	if code := <-codes; code != http.StatusOK {
		t.Errorf("the request trying the cluster: %d, want its own answer", code)
	}
	reached = 0
	if code := askKnown(h, ok); code != http.StatusOK || reached != 1 || h.svc.ClusterDown("known") {
		t.Fatalf("after the try succeeded: %d with the handler run %d times, want the breaker closed", code, reached)
	}

	openIt()
	time.Sleep(period + 50*time.Millisecond)
	reached = 0
	if code := askKnown(h, fail); code != http.StatusServiceUnavailable || reached != 1 {
		t.Fatalf("once the period ended: %d with the handler run %d times, want the request let through", code, reached)
	}
	reached = 0
	if code := askKnown(h, ok); code != http.StatusServiceUnavailable || reached != 0 {
		t.Fatalf("after the try failed: %d with the handler run %d times, want a fast 503", code, reached)
	}
}

// MC_BREAKER_CONSECUTIVE_FAILS 0 is the breaker off: every request goes to the cluster, however many have failed.
func TestAClusterWithTheBreakerOffIsAlwaysAsked(t *testing.T) {
	h := breakerHandler(t, k8s.ServiceOptions{})
	reached := 0
	fail := func(w http.ResponseWriter, _ *http.Request) {
		reached++
		h.handleError(w, errors.New("dial tcp 10.0.0.9:6443: connect: connection refused"))
	}
	for i := range 5 {
		if code := askKnown(h, fail); code != http.StatusServiceUnavailable || reached != i+1 {
			t.Fatalf("request %d: %d with the handler run %d times, want every request sent", i+1, code, reached)
		}
	}
	if h.svc.ClusterDown("known") {
		t.Error("the breaker opened while off")
	}
}
