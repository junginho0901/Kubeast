package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// breakerHandler is a Handler on the cluster c1, whose API server answers /version, 503 for downAPIPath, 504 for
// timeoutAPIPath, nothing until the client goes for slowAPIPath, and ends the connection of dropPath with no response.
func breakerHandler(t *testing.T, opts k8s.ServiceOptions) *Handler {
	t.Helper()
	h, _ := countedBreakerHandler(t, opts)
	return h
}

const (
	// downAPIPath is an aggregated API whose server is down: the API server answers it 503.
	downAPIPath = "/apis/metrics.k8s.io/v1beta1/nodes"
	// timeoutAPIPath is a read past the API server's own time limit: it answers 504.
	timeoutAPIPath = "/apis/apps/v1/replicasets"
	// slowAPIPath is a list the API server is still reading when the screen's deadline passes.
	slowAPIPath = "/api/v1/events"
	// dropPath is an access check (a POST) whose connection ends with no response, as one to an API server going away.
	dropPath = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"
)

// countedBreakerHandler is breakerHandler with the number of requests its API server got.
func countedBreakerHandler(t *testing.T, opts k8s.ServiceOptions) (*Handler, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case downAPIPath:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"ServiceUnavailable","code":503}`))
			return
		case timeoutAPIPath:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusGatewayTimeout)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","message":"Timeout: request did not complete within the allotted timeout","reason":"Timeout","code":504}`))
			return
		case slowAPIPath:
			select {
			case <-r.Context().Done():
			case <-time.After(10 * time.Second):
			}
			return
		case dropPath:
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				_ = conn.Close()
			}
			return
		}
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"35","gitVersion":"v1.35.0"}`))
	}))
	t.Cleanup(api.Close)
	return handlerOn(t, api.URL, opts), &hits
}

// handlerOn is a Handler on the cluster c1 whose API server is at url.
func handlerOn(t *testing.T, url string, opts k8s.ServiceOptions) *Handler {
	t.Helper()
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", url, 1)
	svc, err := k8s.NewService(context.Background(), metricsRegistry{blob: blob}, false, nil, opts)
	if err != nil {
		t.Fatal(err)
	}
	return &Handler{svc: svc, auditStore: &memAudit{}}
}

// askC1 sends one request for the cluster c1 through ClusterMiddleware to next.
func askC1(h *Handler, next http.HandlerFunc) *httptest.ResponseRecorder {
	return askC1As(h, auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}, next)
}

// askC1As is askC1 for the person p.
func askC1As(h *Handler, p auth.TokenPayload, next http.HandlerFunc) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/cluster/overview?cluster=c1", nil)
	req = req.WithContext(auth.WithPayload(req.Context(), p))
	rec := httptest.NewRecorder()
	h.ClusterMiddleware(next).ServeHTTP(rec, req)
	return rec
}

// breakerAnswers are the handlers these tests put behind ClusterMiddleware; reached counts the requests they got.
type breakerAnswers struct {
	h       *Handler
	reached int
}

// failAsTheCluster makes a call whose connection ends with no response (a POST, which client-go does not send again) and
// answers 503, as a screen of a cluster it cannot reach.
func (a *breakerAnswers) failAsTheCluster(w http.ResponseWriter, r *http.Request) {
	a.reached++
	_, _, err := a.h.svc.RawRequest(r.Context(), http.MethodPost, dropPath)
	if err == nil {
		err = errors.New("the dropped connection was answered")
	}
	response.Error(w, http.StatusServiceUnavailable, err.Error())
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

// A trial the namespace guard refused never reached the API server: the guard's 403 is no answer of the cluster.
func TestATrialRefusedByTheNamespaceGuardLeavesTheBreakerOpen(t *testing.T) {
	const period = 500 * time.Millisecond
	h, hits := countedBreakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period, NodeShellNamespace: "kubeast-node-shell"})
	a := &breakerAnswers{h: h}
	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	reader := auth.TokenPayload{UserID: "u2", Email: "r@example.com", Perms: auth.PermissionMatrix{"c1": {"resource.objects.read"}}, Roles: map[string]string{"c1": "Read"}}
	before := hits.Load()
	rec := askC1As(h, reader, func(w http.ResponseWriter, r *http.Request) {
		if _, _, err := h.svc.RawRequest(r.Context(), http.MethodGet, "/api/v1/namespaces/kubeast-node-shell/pods/p/log"); err != nil {
			h.handleError(w, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	if rec.Code != http.StatusForbidden || hits.Load() != before {
		t.Fatalf("the guarded read: %d with %d requests at the API server, want the guard's 403 and none", rec.Code, hits.Load()-before)
	}
	if !h.svc.ClusterDown("c1") {
		t.Fatal("the guard's refusal closed the breaker")
	}
	if code := askC1(h, a.askTheCluster).Code; code != http.StatusOK || h.svc.ClusterDown("c1") {
		t.Fatalf("the next request: %d, open %v: want it to try the cluster and close the breaker", code, h.svc.ClusterDown("c1"))
	}
}

// Open, only the trial closes the breaker: a request let in before it opened and answered after does not, whether a
// cache or the API server answered it.
func TestOnlyTheTrialClosesAnOpenBreaker(t *testing.T) {
	for name, answerLate := range map[string]func(a *breakerAnswers) http.HandlerFunc{
		"from a cache":      func(a *breakerAnswers) http.HandlerFunc { return a.answerFromACache },
		"by the API server": func(a *breakerAnswers) http.HandlerFunc { return a.askTheCluster },
	} {
		t.Run(name, func(t *testing.T) {
			a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: time.Minute})}
			late := answerLate(&breakerAnswers{h: a.h})
			admitted, release, done := make(chan struct{}), make(chan struct{}), make(chan int, 1)
			go func() {
				done <- askC1(a.h, func(w http.ResponseWriter, r *http.Request) {
					close(admitted)
					<-release
					late(w, r)
				}).Code
			}()
			select {
			case <-admitted:
			case code := <-done:
				t.Fatalf("the request was not let in: %d", code)
			}
			if code := askC1(a.h, a.failAsTheCluster).Code; code != http.StatusServiceUnavailable || !a.h.svc.ClusterDown("c1") {
				t.Fatalf("the breaker did not open: %d", code)
			}
			close(release)
			if code := <-done; code != http.StatusOK {
				t.Fatalf("the request let in before: %d", code)
			}
			if !a.h.svc.ClusterDown("c1") {
				t.Error("a request that was no trial closed the open breaker")
			}
		})
	}
}

// Closed, an answer of the API server clears the failures counted; an answer that is not one (a socket that ends
// without a status written, as a hijacked connection's) does not.
func TestAnAnswerOfTheAPIServerClearsTheCountOfAClosedBreaker(t *testing.T) {
	silent := func(http.ResponseWriter, *http.Request) {}
	for name, c := range map[string]struct {
		between  http.HandlerFunc
		wantOpen bool
	}{
		"the API server answered": {nil, false},
		"nothing was asked":       {silent, true},
	} {
		t.Run(name, func(t *testing.T) {
			a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 2, BreakerOpen: time.Minute})}
			between := c.between
			if between == nil {
				between = a.askTheCluster
			}
			askC1(a.h, a.failAsTheCluster)
			if code := askC1(a.h, between).Code; code != http.StatusOK {
				t.Fatalf("the request between: %d", code)
			}
			askC1(a.h, a.failAsTheCluster)
			if a.h.svc.ClusterDown("c1") != c.wantOpen {
				t.Errorf("open %v after a failure, the request between and a failure, want %v", a.h.svc.ClusterDown("c1"), c.wantOpen)
			}
		})
	}
}

// A terminal or a followed log trying the cluster closes the breaker at the API server's first answer, not when it ends.
func TestAStreamTryingTheClusterClosesTheBreakerAtItsFirstAnswer(t *testing.T) {
	const period = 500 * time.Millisecond
	a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	streaming, release, done := make(chan struct{}), make(chan struct{}), make(chan int, 1)
	go func() {
		done <- askC1(a.h, func(w http.ResponseWriter, r *http.Request) {
			if _, _, err := a.h.svc.RawRequest(r.Context(), http.MethodGet, "/version"); err != nil {
				a.h.handleError(w, err)
				close(streaming)
				return
			}
			close(streaming)
			<-release
		}).Code
	}()
	select {
	case <-streaming:
	case code := <-done:
		t.Fatalf("the stream was not let through: %d", code)
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not start")
	}
	if a.h.svc.ClusterDown("c1") {
		close(release)
		t.Fatal("the breaker stayed open while the stream that the API server answered went on")
	}
	a.reached = 0
	if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 {
		t.Errorf("a request beside the stream: %d with the handler run %d times, want it sent", code, a.reached)
	}
	close(release)
	<-done
}

// A trial whose call to the cluster failed before an answer (no status) closes nothing, though its handler answered 200.
func TestATrialWhoseCallGotNoAnswerLeavesTheBreakerOpen(t *testing.T) {
	const period = 500 * time.Millisecond
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	a := &breakerAnswers{h: handlerOn(t, url, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
	openC1(t, a)
	time.Sleep(period + 50*time.Millisecond)
	swallowed := func(w http.ResponseWriter, r *http.Request) {
		a.reached++
		_, _, err := a.h.svc.RawRequest(r.Context(), http.MethodGet, "/version")
		if err == nil {
			t.Error("a request to a closed address was answered")
		}
		w.WriteHeader(http.StatusOK)
	}
	if code := askC1(a.h, swallowed).Code; code != http.StatusOK || a.reached != 1 {
		t.Fatalf("the trial: %d with the handler run %d times", code, a.reached)
	}
	if !a.h.svc.ClusterDown("c1") {
		t.Error("a call that got no answer closed the breaker")
	}
}

// A trial refused by the cluster's rate limit, or one whose handler panicked, gives its try back to the next request.
func TestATrialThatDidNotRunGivesItsTryBack(t *testing.T) {
	t.Run("rate limited", func(t *testing.T) {
		const period = 2 * time.Second
		a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period, RateLimitQPS: 1, RateLimitBurst: 1})}
		if code := askC1(a.h, a.failAsTheCluster).Code; code != http.StatusServiceUnavailable || !a.h.svc.ClusterDown("c1") {
			t.Fatalf("the breaker did not open: %d", code)
		}
		time.Sleep(period + 100*time.Millisecond)
		_ = a.h.svc.AllowRequest("c1") // another request took the token
		if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusTooManyRequests {
			t.Fatalf("the trial: %d, want 429", code)
		}
		time.Sleep(1100 * time.Millisecond) // the token is back, the period booked is not over
		a.reached = 0
		if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 || a.h.svc.ClusterDown("c1") {
			t.Fatalf("the next request: %d with the handler run %d times, open %v: want it to try and close", code, a.reached, a.h.svc.ClusterDown("c1"))
		}
	})
	t.Run("panicked", func(t *testing.T) {
		const period = 500 * time.Millisecond
		a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
		openC1(t, a)
		time.Sleep(period + 50*time.Millisecond)
		func() {
			defer func() { _ = recover() }()
			askC1(a.h, func(http.ResponseWriter, *http.Request) { panic("handler") })
		}()
		a.reached = 0
		if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 || a.h.svc.ClusterDown("c1") {
			t.Fatalf("the next request: %d with the handler run %d times, open %v: want it to try and close", code, a.reached, a.h.svc.ClusterDown("c1"))
		}
	})
}

// A 5xx of the API server (an aggregated API whose server is down) is no answer: a trial it answered closes nothing, and
// for another request it clears no failures, even when the handler goes on to write 200.
func TestA5xxOfTheAPIServerIsNoAnswer(t *testing.T) {
	askTheDownAPI := func(a *breakerAnswers) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			a.reached++
			if _, code, err := a.h.svc.RawRequest(r.Context(), http.MethodGet, downAPIPath); err == nil || code != http.StatusServiceUnavailable {
				t.Errorf("the down API: %d %v, want its 503", code, err)
			}
			w.WriteHeader(http.StatusOK)
		}
	}
	t.Run("a trial", func(t *testing.T) {
		const period = 500 * time.Millisecond
		a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
		openC1(t, a)
		time.Sleep(period + 50*time.Millisecond)
		a.reached = 0
		if code := askC1(a.h, askTheDownAPI(a)).Code; code != http.StatusOK || a.reached != 1 {
			t.Fatalf("the trial: %d with the handler run %d times", code, a.reached)
		}
		if !a.h.svc.ClusterDown("c1") {
			t.Error("a 503 of the API server closed the breaker")
		}
	})
	t.Run("another request", func(t *testing.T) {
		a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 2, BreakerOpen: time.Minute})}
		askC1(a.h, a.failAsTheCluster)
		askC1(a.h, askTheDownAPI(a))
		askC1(a.h, a.failAsTheCluster)
		if !a.h.svc.ClusterDown("c1") {
			t.Error("a 503 of the API server between two failures cleared the count")
		}
	})
}

// A cluster whose API server answers is not cut off by one group or one slow screen: an aggregated API whose server is
// down (503), the API server's own timeout (504) and a screen's deadline that passed once its request was sent count no
// failure, though each screen answers 503.
func TestAClusterWhoseAPIServerAnswersIsNotCutOffByOneGroupOrOneSlowScreen(t *testing.T) {
	for name, c := range map[string]struct {
		path     string
		deadline time.Duration
	}{
		"an aggregated API answering 503":           {downAPIPath, 0},
		"the API server's 504":                      {timeoutAPIPath, 0},
		"a screen's deadline once its request went": {slowAPIPath, 200 * time.Millisecond},
	} {
		t.Run(name, func(t *testing.T) {
			a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 2, BreakerOpen: time.Minute})}
			for i := range 3 {
				if rec := askC1(a.h, a.read(c.path, c.deadline)); rec.Code != http.StatusServiceUnavailable {
					t.Fatalf("read %d: %d %s, want the screen's 503", i+1, rec.Code, rec.Body.String())
				}
			}
			if a.h.svc.ClusterDown("c1") {
				t.Error("the breaker of a cluster whose API server answers opened")
			}
		})
	}
}

// read is a screen that GETs path from the cluster, within deadline when one is given, and answers what handleError
// makes of a failure.
func (a *breakerAnswers) read(path string, deadline time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.reached++
		ctx := r.Context()
		if deadline > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, deadline)
			defer cancel()
		}
		if _, _, err := a.h.svc.RawRequest(ctx, http.MethodGet, path); err != nil {
			a.h.handleError(w, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	}
}

// A trial the cluster took and answered none below 500 holds the breaker another period, as a proxy in front of an API
// server that is down answers: the next request still fails fast. A trial that made no call gives its try back.
func TestATrialTheClusterTookAndDidNotAnswerHoldsThePeriod(t *testing.T) {
	for name, c := range map[string]struct {
		path     string
		deadline time.Duration
	}{
		"a 503":                            {downAPIPath, 0},
		"a deadline once its request went": {slowAPIPath, 200 * time.Millisecond},
	} {
		t.Run(name, func(t *testing.T) {
			const period = 500 * time.Millisecond
			a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
			openC1(t, a)
			time.Sleep(period + 50*time.Millisecond)
			a.reached = 0
			if code := askC1(a.h, a.read(c.path, c.deadline)).Code; code != http.StatusServiceUnavailable || a.reached != 1 {
				t.Fatalf("the trial: %d with the handler run %d times", code, a.reached)
			}
			a.reached = 0
			if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusServiceUnavailable || a.reached != 0 {
				t.Fatalf("right after the trial: %d with the handler run %d times, want a fast 503", code, a.reached)
			}
			time.Sleep(period + 50*time.Millisecond)
			if code := askC1(a.h, a.askTheCluster).Code; code != http.StatusOK || a.reached != 1 || a.h.svc.ClusterDown("c1") {
				t.Fatalf("a period after the trial: %d with the handler run %d times, open %v: want it tried and closed", code, a.reached, a.h.svc.ClusterDown("c1"))
			}
		})
	}
}

// A request's record is of its own cluster: calls to another (a live list socket opened on c1 subscribing to c2) neither
// mark c1 down nor answer its trial.
func TestACallToAnotherClusterCountsForNeither(t *testing.T) {
	askC2 := func(a *breakerAnswers) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			a.reached++
			_, _, _ = a.h.svc.RawRequest(cluster.WithID(r.Context(), "c2"), http.MethodGet, "/version")
			w.WriteHeader(http.StatusOK)
		}
	}
	t.Run("refused", func(t *testing.T) {
		refused := httptest.NewServer(http.NotFoundHandler())
		url := refused.URL
		refused.Close()
		a := &breakerAnswers{h: handlerOn(t, url, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: time.Minute})}
		if code := askC1(a.h, askC2(a)).Code; code != http.StatusOK || a.reached != 1 {
			t.Fatalf("the request: %d with the handler run %d times", code, a.reached)
		}
		if a.h.svc.ClusterDown("c1") {
			t.Error("a refused call to c2 marked c1 down")
		}
	})
	t.Run("answered", func(t *testing.T) {
		const period = 500 * time.Millisecond
		a := &breakerAnswers{h: breakerHandler(t, k8s.ServiceOptions{BreakerFails: 1, BreakerOpen: period})}
		openC1(t, a)
		time.Sleep(period + 50*time.Millisecond)
		askC1(a.h, askC2(a))
		if !a.h.svc.ClusterDown("c1") {
			t.Error("c2's answer closed c1's breaker")
		}
	})
}

// A read several requests share counts once for each run: the request that found none under way reads for itself, and
// those that came meanwhile wait on one more read, which counts for the first of them. Three such requests to a cluster
// that refuses count two failures, where each waiting request counted one before.
func TestASharedReadOfAClusterItCannotReachCountsOncePerRun(t *testing.T) {
	refused := httptest.NewServer(http.NotFoundHandler())
	url := refused.URL
	refused.Close()
	for name, c := range map[string]struct {
		fails    int
		wantOpen bool
	}{
		"two failures do not reach three": {3, false},
		"two failures reach two":          {2, true},
	} {
		t.Run(name, func(t *testing.T) {
			h := handlerOn(t, url, k8s.ServiceOptions{BreakerFails: c.fails, BreakerOpen: time.Minute})
			release := make(chan struct{})
			var runs atomic.Int32
			read := h.Shared(func(w http.ResponseWriter, r *http.Request) {
				if runs.Add(1) == 1 {
					<-release
				}
				if _, _, err := h.svc.RawRequest(r.Context(), http.MethodGet, "/version"); err != nil {
					h.handleError(w, err)
					return
				}
				w.WriteHeader(http.StatusOK)
			})
			var wg sync.WaitGroup
			ask := func() {
				wg.Add(1)
				go func() {
					defer wg.Done()
					askC1(h, read)
				}()
			}
			ask()
			for deadline := time.Now().Add(5 * time.Second); runs.Load() == 0 && time.Now().Before(deadline); {
				time.Sleep(5 * time.Millisecond)
			}
			ask()
			ask()
			time.Sleep(300 * time.Millisecond) // the two wait on the read under way
			close(release)
			wg.Wait()
			if n := runs.Load(); n != 2 {
				t.Fatalf("%d runs of the read, want the first request's own and one for the two after it", n)
			}
			if h.svc.ClusterDown("c1") != c.wantOpen {
				t.Errorf("open %v after three requests sharing two reads, want %v", h.svc.ClusterDown("c1"), c.wantOpen)
			}
		})
	}
}
