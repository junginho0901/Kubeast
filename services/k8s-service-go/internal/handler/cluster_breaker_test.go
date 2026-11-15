package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// breakerHandler is a Handler on the cluster c1, whose API server answers /version.
func breakerHandler(t *testing.T, opts k8s.ServiceOptions) *Handler {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"35","gitVersion":"v1.35.0"}`))
	}))
	t.Cleanup(api.Close)
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", api.URL, 1)
	svc, err := k8s.NewService(context.Background(), metricsRegistry{blob: blob}, false, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{svc: svc, auditStore: &memAudit{}}
}

// askC1 sends one request for the cluster c1 through ClusterMiddleware to next.
func askC1(h *Handler, next http.HandlerFunc) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/cluster/overview?cluster=c1", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}))
	rec := httptest.NewRecorder()
	h.ClusterMiddleware(next).ServeHTTP(rec, req)
	return rec
}

// breakerAnswers are the handlers these tests put behind ClusterMiddleware; reached counts the requests they got.
type breakerAnswers struct {
	h       *Handler
	reached int
}

func (a *breakerAnswers) failAsTheCluster(w http.ResponseWriter, _ *http.Request) {
	a.reached++
	a.h.handleError(w, errors.New("dial tcp 10.0.0.9:6443: connect: connection refused"))
}

func (a *breakerAnswers) askTheCluster(w http.ResponseWriter, r *http.Request) {
	a.reached++
	if _, _, err := a.h.svc.RawRequest(r.Context(), http.MethodGet, "/version"); err != nil {
		a.h.handleError(w, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (a *breakerAnswers) answerFromACache(w http.ResponseWriter, r *http.Request) {
	a.reached++
	accesstrail.Cached(r.Context(), "a cache of the test")
	w.WriteHeader(http.StatusOK)
}

// openC1 opens the breaker of c1 with a failed call and checks that the next request fails fast.
func openC1(t *testing.T, a *breakerAnswers) {
	t.Helper()
	if code := askC1(a.h, a.failAsTheCluster).Code; code != http.StatusServiceUnavailable || !a.h.svc.ClusterDown("c1") {
		t.Fatalf("a failed call to the cluster: %d, open %v", code, a.h.svc.ClusterDown("c1"))
	}
	a.reached = 0
	if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusServiceUnavailable || a.reached != 0 {
		t.Fatalf("right after it opened: %d with the handler run %d times, want a fast 503", code, a.reached)
	}
}

// An open cluster fails fast for MC_BREAKER_OPEN_SEC; then one request goes to the cluster while the others still fail
// fast. Its success closes the breaker, so a screen's own request brings the cluster back; its failure opens it again.
func TestAnOpenClusterIsTriedByOneRequestAfterItsPeriod(t *testing.T) {
	const period = time.Second
	a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}

	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	release := make(chan struct{})
	var entered atomic.Int32
	waitThenAsk := func(w http.ResponseWriter, r *http.Request) {
		entered.Add(1)
		<-release
		if _, _, err := a.h.svc.RawRequest(r.Context(), http.MethodGet, "/version"); err != nil {
			a.h.handleError(w, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	}
	codes := make(chan int, 8)
	for range 8 {
		go func() { codes <- askC1(a.h, waitThenAsk).Code }()
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
	a.reached = 0
	if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 || a.h.svc.ClusterDown("c1") {
		t.Fatalf("after the try succeeded: %d with the handler run %d times, want the breaker closed", code, a.reached)
	}

	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	a.reached = 0
	if code := askC1(a.h, a.failAsTheCluster).Code; code != http.StatusServiceUnavailable || a.reached != 1 {
		t.Fatalf("once the period ended: %d with the handler run %d times, want the request let through", code, a.reached)
	}
	a.reached = 0
	if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusServiceUnavailable || a.reached != 0 {
		t.Fatalf("after the try failed: %d with the handler run %d times, want a fast 503", code, a.reached)
	}
}

// A trial answered from a cache did not reach the cluster: the breaker stays open and the next request tries it. Only an
// answer of the API server closes it.
func TestATrialAnsweredFromACacheLeavesTheBreakerOpen(t *testing.T) {
	const period = time.Second
	a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	for try := 1; try <= 2; try++ {
		a.reached = 0
		rec := askC1(a.h, a.answerFromACache)
		if rec.Code != http.StatusOK || a.reached != 1 {
			t.Fatalf("try %d: %d with the handler run %d times, want the request let through", try, rec.Code, a.reached)
		}
		if !a.h.svc.ClusterDown("c1") {
			t.Fatalf("try %d: an answer from a cache closed the breaker", try)
		}
		if got := rec.Header().Get(accesstrail.HeaderRequests); got != "" {
			t.Errorf("try %d: the trial's own record went out in %s: %q", try, accesstrail.HeaderRequests, got)
		}
	}
	a.reached = 0
	if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 || a.h.svc.ClusterDown("c1") {
		t.Fatalf("a trial the cluster answered: %d with the handler run %d times, open %v: want it closed", code, a.reached, a.h.svc.ClusterDown("c1"))
	}
}

// MC_BREAKER_CONSECUTIVE_FAILS 0 is the breaker off: every request goes to the cluster, however many have failed.
func TestAClusterWithTheBreakerOffIsAlwaysAsked(t *testing.T) {
	a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{})}
	for i := range 5 {
		if code := askC1(a.h, a.failAsTheCluster).Code; code != http.StatusServiceUnavailable || a.reached != i+1 {
			t.Fatalf("request %d: %d with the handler run %d times, want every request sent", i+1, code, a.reached)
		}
	}
	if a.h.svc.ClusterDown("c1") {
		t.Error("the breaker opened while off")
	}
}
