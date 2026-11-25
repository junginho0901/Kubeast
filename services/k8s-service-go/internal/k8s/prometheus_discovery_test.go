package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// promServer stands in for a cluster API server: with found, monitoring holds a
// Service "prometheus" on 9090 whose proxy answers /-/healthy (refused with
// healthy403, the way a cluster refuses an identity without services/proxy)
// and /api/v1/query; every other Service list is empty.
type promServer struct {
	found      bool
	healthy403 bool
	// labelled: an "o11y/prometheus-server" Service on port 80 carries the
	// prometheus chart's server labels (found by the cluster-wide label list).
	labelled bool
	mu       sync.Mutex
	lists    int
	queries  int
	// failing: every Service list answers 500, as an API server that cannot list does.
	failing bool
	// gate, while set, keeps every Service list waiting, as an API server slow to list.
	gate chan struct{}
	// people is the person each Service list came as ("" for a request of no one's).
	people []string
	url    string
}

func (p *promServer) counts() (lists, queries int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lists, p.queries
}

// hold keeps the Service lists waiting, and those that wait go on once it is off.
func (p *promServer) hold(on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case on && p.gate == nil:
		p.gate = make(chan struct{})
	case !on && p.gate != nil:
		close(p.gate)
		p.gate = nil
	}
}

// waitLists waits for n Service lists to have come.
func (p *promServer) waitLists(t *testing.T, n int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(2 * time.Millisecond) {
		if lists, _ := p.counts(); lists >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d Service lists never came", n)
		}
	}
}

// become changes what the cluster holds between two calls.
func (p *promServer) become(found, failing bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.found, p.failing = found, failing
}

func newPromServer(t *testing.T, found, healthy403 bool) (*kubernetes.Clientset, *promServer) {
	t.Helper()
	ps := &promServer{found: found, healthy403: healthy403}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		ps.mu.Lock()
		found, failing := ps.found, ps.failing
		ps.mu.Unlock()
		switch {
		case strings.HasSuffix(p, "/services"):
			ps.mu.Lock()
			ps.lists++
			ps.people = append(ps.people, r.Header.Get(auth.HeaderImpersonateUser))
			gate := ps.gate
			ps.mu.Unlock()
			if gate != nil {
				select {
				case <-gate:
				case <-r.Context().Done():
					return
				}
			}
			if failing {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"InternalError","code":500}`))
				return
			}
			if ps.labelled && p == "/api/v1/services" && r.URL.Query().Get("labelSelector") == "app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server" {
				_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"prometheus-server","namespace":"o11y"},"spec":{"ports":[{"name":"http","port":80}]}}]}`))
				return
			}
			if found && p == "/api/v1/namespaces/monitoring/services" {
				_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"prometheus","namespace":"monitoring"},"spec":{"ports":[{"name":"web","port":9090}]}}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"items":[]}`))
		case found && p == "/api/v1/namespaces/monitoring/services/prometheus":
			_, _ = w.Write([]byte(`{"metadata":{"name":"prometheus","namespace":"monitoring"},"spec":{"ports":[{"name":"web","port":9090}]}}`))
		case ps.healthy403 && strings.HasSuffix(p, "/proxy/-/healthy"):
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
		case ps.labelled && p == "/api/v1/namespaces/o11y/services/prometheus-server:80/proxy/-/healthy":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("Prometheus Server is Healthy.\n"))
		case found && p == "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/-/healthy":
			if ps.healthy403 {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
				return
			}
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("Prometheus Server is Healthy.\n"))
		case p == "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query":
			ps.mu.Lock()
			ps.queries++
			ps.mu.Unlock()
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1,"1"]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	ps.url = srv.URL
	t.Cleanup(srv.Close)
	t.Cleanup(func() { ps.hold(false) })
	// no client rate limit: a second discovery round would otherwise wait for its 5 a second
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	return cs, ps
}

func newPromService(caller *kubernetes.Clientset, view kubernetes.Interface) *Service {
	s := &Service{promQ: newPromQueryCache(0)}
	b := &clientBundle{clientset: caller, prom: &promCache{}}
	if view != nil {
		b.cacheClient = view
	}
	s.defaultBundle.Store(b)
	return s
}

func promDiscoveryEnv(t *testing.T) {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_URL", "")
	t.Setenv("PROMETHEUS_AUTH_HEADER", "")
	t.Setenv("PROMETHEUS_DISCOVER", "")
	t.Setenv("PROMETHEUS_SERVICE", "")
}

// One discovery round: a cluster-wide list per label selector, then the namespaces.
var oneRound = len(PrometheusServiceLabels) + 7

// Discovery runs as the cache identity (which may list the Service even when
// the caller may not), the result is remembered for the cluster, and the
// queries themselves go out as the caller.
func TestPrometheusDiscovery_RunsAsCacheIdentity(t *testing.T) {
	promDiscoveryEnv(t)
	ctx := context.Background()
	callerCS, caller := newPromServer(t, false, false)
	viewCS, view := newPromServer(t, true, false)
	s := newPromService(callerCS, viewCS)

	st := s.PrometheusStatus(ctx)
	if st["available"] != true || st["source"] != "proxy" || st["endpoint"] != "monitoring/prometheus:9090 (via K8s API proxy)" {
		t.Fatalf("status = %v", st)
	}
	rows, err := s.PrometheusQueryRaw(ctx, "up")
	if err != nil || len(rows) != 1 {
		t.Fatalf("query rows = %v err = %v", rows, err)
	}
	if lists, queries := view.counts(); lists == 0 || queries != 0 {
		t.Fatalf("cache identity: lists=%d (want >0) queries=%d (want 0)", lists, queries)
	}
	if lists, queries := caller.counts(); lists != 0 || queries != 1 {
		t.Fatalf("caller: lists=%d (want 0) queries=%d (want 1)", lists, queries)
	}
	// Remembered: a second status does not probe again.
	if _, ok := s.PrometheusStatus(ctx)["endpoint"]; !ok {
		t.Fatal("status lost the endpoint")
	}
	if lists, _ := view.counts(); lists != oneRound {
		t.Fatalf("service lists = %d, want one round (%d)", lists, oneRound)
	}
}

// A cluster that refuses the discovery identity's /-/healthy still has the
// Service: found, not remembered as missing for everyone.
func TestPrometheusDiscovery_ForbiddenHealthyStillFound(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, true)
	s := newPromService(cs, nil)
	st := s.PrometheusStatus(context.Background())
	if st["available"] != true || st["source"] != "proxy" {
		t.Fatalf("status with a refused /-/healthy = %v", st)
	}
	if lists, _ := srv.counts(); lists != oneRound {
		t.Fatalf("service lists = %d, want %d (bundle clientset stands in for the cache identity)", lists, oneRound)
	}
}

// No Service anywhere: not found, probed once per TTL.
func TestPrometheusDiscovery_NotFoundProbedOnce(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, false, false)
	s := newPromService(cs, nil)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if st := s.PrometheusStatus(ctx); st["available"] != false || st["message"] != "Prometheus not found in target cluster" || st["reason"] != "not_found" {
			t.Fatalf("call %d: status = %v", i+1, st)
		}
	}
	// nothing found: the VictoriaMetrics label lists follow the one namespace round
	if lists, _ := srv.counts(); lists != oneRound+len(VictoriaMetricsServiceLabels) {
		t.Fatalf("service lists = %d, want one round (%d)", lists, oneRound+len(VictoriaMetricsServiceLabels))
	}
}

// missRound is one discovery that finds nothing: the Prometheus labels, the namespaces, then the VictoriaMetrics labels.
var missRound = oneRound + len(VictoriaMetricsServiceLabels)

// passPromTime moves the cluster's remembered discovery back by d, as d passing would, so no test waits.
func passPromTime(s *Service, d time.Duration) {
	c := s.defaultBundle.Load().prom
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probedAt = c.probedAt.Add(-d)
}

func promAvailable(s *Service) bool {
	return s.PrometheusStatus(context.Background())["available"] == true
}

// A cluster where nothing was found is asked again a minute later, not ten: a Prometheus installed since shows then.
func TestPrometheusDiscovery_NothingFoundIsAskedAgainAfterAMinute(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, false, false)
	s := newPromService(cs, nil)
	if promAvailable(s) {
		t.Fatal("found in a cluster without one")
	}
	srv.become(true, false)
	passPromTime(s, 59*time.Second)
	if promAvailable(s) {
		t.Error("asked again within the minute")
	}
	if lists, _ := srv.counts(); lists != missRound {
		t.Errorf("service lists within the minute = %d, want one discovery (%d)", lists, missRound)
	}
	passPromTime(s, 2*time.Second)
	if !promAvailable(s) {
		t.Error("not asked again a minute after nothing was found")
	}
	if lists, _ := srv.counts(); lists != missRound+oneRound {
		t.Errorf("service lists after the minute = %d, want a second discovery (%d)", lists, missRound+oneRound)
	}
}

// A discovery whose lists failed is remembered for a minute too: an API server that could not answer is asked again.
func TestPrometheusDiscovery_AFailedDiscoveryIsAskedAgainAfterAMinute(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	srv.become(true, true)
	s := newPromService(cs, nil)
	if st := s.PrometheusStatus(context.Background()); st["available"] != false || st["reason"] != "not_found" {
		t.Fatalf("status while the lists fail = %v", st)
	}
	srv.become(true, false)
	passPromTime(s, 59*time.Second)
	if promAvailable(s) {
		t.Error("asked again within the minute")
	}
	if lists, _ := srv.counts(); lists != missRound {
		t.Errorf("service lists within the minute = %d, want one discovery (%d)", lists, missRound)
	}
	passPromTime(s, 2*time.Second)
	if !promAvailable(s) {
		t.Error("not asked again a minute after the lists failed")
	}
	if lists, _ := srv.counts(); lists != missRound+oneRound {
		t.Errorf("service lists after the minute = %d, want a second discovery (%d)", lists, missRound+oneRound)
	}
}

// askPrometheus is PrometheusAvailable on ctx, whose answer comes on the channel.
func askPrometheus(ctx context.Context, s *Service) <-chan bool {
	answer := make(chan bool, 1)
	go func() { answer <- s.PrometheusAvailable(ctx) }()
	return answer
}

// searchAnswer is the answer of a caller who must have one by now.
func searchAnswer(t *testing.T, who string, answer <-chan bool) bool {
	t.Helper()
	select {
	case ok := <-answer:
		return ok
	case <-time.After(3 * time.Second):
		t.Fatalf("%s has no answer", who)
		return false
	}
}

// A caller leaving cuts no search: it goes on, and what it finds is remembered, with no second one.
func TestPrometheusDiscovery_ASearchOutlivesTheCallerWhoStartedIt(t *testing.T) {
	for name, cut := range map[string]func() (context.Context, context.CancelFunc){
		"its caller left": func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(150*time.Millisecond, cancel)
			return ctx, cancel
		},
		"its caller's own time ended": func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), 150*time.Millisecond)
		},
	} {
		t.Run(name, func(t *testing.T) {
			promDiscoveryEnv(t)
			cs, srv := newPromServer(t, true, false)
			srv.hold(true)
			s := newPromService(cs, nil)
			ctx, cancel := cut()
			defer cancel()
			if searchAnswer(t, "the caller who left", askPrometheus(ctx, s)) {
				t.Fatal("found while every list waits")
			}
			srv.hold(false)
			if !promAvailable(s) {
				t.Error("not found by the search that went on")
			}
			if lists, _ := srv.counts(); lists != oneRound {
				t.Errorf("service lists = %d, want one discovery (%d)", lists, oneRound)
			}
		})
	}
}

// A request that has ended, and one whose reads of the cluster are held, start no search and take the last one found.
func TestPrometheusDiscovery_ARequestThatSendsNoReadStartsNoSearch(t *testing.T) {
	gone, leave := context.WithCancel(context.Background())
	leave()
	held, calls := WithClusterCalls(context.Background(), "", func() {})
	calls.waitedOut.Store(true)
	for name, ctx := range map[string]context.Context{"it had ended": gone, "its reads are held": held} {
		t.Run(name, func(t *testing.T) {
			promDiscoveryEnv(t)
			cs, srv := newPromServer(t, true, false)
			s := newPromService(cs, nil)
			if s.PrometheusAvailable(ctx) {
				t.Error("found with no search")
			}
			time.Sleep(50 * time.Millisecond) // a search left running would have listed by now
			if lists, _ := srv.counts(); lists != 0 {
				t.Errorf("service lists = %d, want none", lists)
			}
			if !promAvailable(s) {
				t.Fatal("the next caller did not look")
			}
			passPromTime(s, 10*time.Minute+time.Second)
			srv.become(false, false)
			if !s.PrometheusAvailable(ctx) {
				t.Error("the last one found did not stand")
			}
			if promAvailable(s) {
				t.Error("the next caller did not look again")
			}
		})
	}
}

// A caller in line for another's search leaves when its own time ends, not when that search does.
func TestPrometheusDiscovery_ACallerInLineLeavesOnItsOwnTime(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	srv.hold(true)
	s := newPromService(cs, nil)
	first := askPrometheus(context.Background(), s)
	srv.waitLists(t, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if searchAnswer(t, "the caller in line", askPrometheus(ctx, s)) {
		t.Error("found while every list waits")
	}
	srv.hold(false)
	if !searchAnswer(t, "the first caller", first) {
		t.Error("the first caller's search was cut")
	}
	if lists, _ := srv.counts(); lists != oneRound {
		t.Errorf("service lists = %d, want one discovery (%d)", lists, oneRound)
	}
}

// A cluster slower to list than any caller waits costs callers who come faster than a search takes one search between
// them, and what it ended in is remembered: without that each started over and none ever waited a whole one.
func TestPrometheusDiscovery_CallersNoneOfWhomWaitsAWholeSearchShareOne(t *testing.T) {
	was := discoveryTime
	discoveryTime = 400 * time.Millisecond
	t.Cleanup(func() { discoveryTime = was })
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	srv.hold(true)
	s := newPromService(cs, nil)
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			s.PrometheusAvailable(ctx)
		}()
		time.Sleep(40 * time.Millisecond)
	}
	wg.Wait()
	if promAvailable(s) {
		t.Fatal("found though every list waits")
	}
	srv.hold(false)
	if promAvailable(s) {
		t.Error("asked again within the minute")
	}
	if lists, _ := srv.counts(); lists != 1 {
		t.Errorf("service lists = %d, want the one that waited a whole search", lists)
	}
}

// A search goes out as the person who started it, also once they have left, and as no one else who asks meanwhile.
func TestPrometheusDiscovery_ASearchKeepsThePersonWhoStartedIt(t *testing.T) {
	promDiscoveryEnv(t)
	_, srv := newPromServer(t, true, false)
	cfg := &rest.Config{Host: srv.url, QPS: -1}
	wrapPerson(cfg, "c1")
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	s := newPromService(cs, nil)
	srv.hold(true)
	ctx, leave := context.WithCancel(asUser(context.Background(), "ann", nil))
	ann := askPrometheus(ctx, s)
	srv.waitLists(t, 1)
	leave()
	searchAnswer(t, "ann", ann)
	bob := askPrometheus(asUser(context.Background(), "bob", nil), s)
	srv.hold(false)
	if !searchAnswer(t, "bob", bob) {
		t.Error("not found by the search ann started")
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.people) != oneRound {
		t.Errorf("service lists = %d, want one discovery (%d)", len(srv.people), oneRound)
	}
	for i, who := range srv.people {
		if who != "ann@example.com" {
			t.Errorf("list %d went out as %q, want ann@example.com", i+1, who)
		}
	}
}

// A search is not held with the other reads of the request that started it, and that request's record, not those of the
// requests in line, says what its calls got.
func TestPrometheusDiscovery_ASearchIsNotHeldAndIsItsStartersOnTheRecord(t *testing.T) {
	promDiscoveryEnv(t)
	_, srv := newPromServer(t, true, false)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.url, QPS: -1, WrapTransport: func(rt http.RoundTripper) http.RoundTripper {
		return newReadWait(answerNotice{base: rt}, "", "")
	}})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	s := newPromService(cs, nil)
	var answered atomic.Int64
	ctx, calls := WithClusterCalls(context.Background(), "", func() { answered.Add(1) })
	inLine, lineCalls := WithClusterCalls(context.Background(), "", func() { answered.Add(100) })
	srv.hold(true)
	first := askPrometheus(ctx, s)
	srv.waitLists(t, 1)
	second := askPrometheus(inLine, s)
	calls.waitedOut.Store(true) // another of its reads ran out its wait meanwhile
	srv.hold(false)
	if !searchAnswer(t, "the request that started it", first) || !searchAnswer(t, "the request in line", second) {
		t.Error("not found: the search was held with its request's reads")
	}
	if lists, _ := srv.counts(); lists != oneRound {
		t.Errorf("service lists = %d, want one discovery (%d)", lists, oneRound)
	}
	if !calls.gotAnswer.Load() || answered.Load() != 1 {
		t.Errorf("the starter's record: answer %v, its breaker told %d times, want true and once", calls.gotAnswer.Load(), answered.Load())
	}
	if lineCalls.gotAnswer.Load() || lineCalls.responded.Load() {
		t.Error("the request in line has calls it did not make on its record")
	}
}

// A cluster that could not be reached by a search counts for the request that started it, as its own reads do.
func TestPrometheusDiscovery_ASearchThatCouldNotReachTheClusterSaysSo(t *testing.T) {
	promDiscoveryEnv(t)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: gone.URL, QPS: -1, WrapTransport: func(rt http.RoundTripper) http.RoundTripper {
		return newReadWait(answerNotice{base: rt}, "", "")
	}})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	ctx, calls := WithClusterCalls(context.Background(), "", func() {})
	if newPromService(cs, nil).PrometheusAvailable(ctx) {
		t.Fatal("found in a cluster that cannot be reached")
	}
	if !calls.Unreached() {
		t.Error("the request's record does not say its cluster could not be reached")
	}
}

// A search that panics takes nothing down and is not remembered.
func TestPrometheusDiscovery_ASearchThatPanicsIsNotRemembered(t *testing.T) {
	promDiscoveryEnv(t)
	view := fake.NewSimpleClientset()
	var lists atomic.Int64
	view.PrependReactor("list", "services", func(ktesting.Action) (bool, runtime.Object, error) {
		lists.Add(1)
		panic("a list that panics")
	})
	s := newPromService(nil, view)
	for range 2 {
		if promAvailable(s) {
			t.Fatal("found by a search that panicked")
		}
	}
	if lists.Load() != 2 {
		t.Errorf("searches = %d, want one for each caller", lists.Load())
	}
}

// A discovery that ran out of its own time is remembered for a minute, as one whose lists failed: a cluster slow to
// list is not asked by every caller in turn.
func TestPrometheusDiscovery_OneOutOfItsOwnTimeIsRememberedForAMinute(t *testing.T) {
	was := discoveryTime
	discoveryTime = 150 * time.Millisecond
	t.Cleanup(func() { discoveryTime = was })
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	srv.hold(true)
	s := newPromService(cs, nil)
	if promAvailable(s) {
		t.Fatal("found though every list was held")
	}
	srv.hold(false)
	lists, _ := srv.counts()
	if promAvailable(s) {
		t.Error("asked again within the minute")
	}
	if now, _ := srv.counts(); now != lists {
		t.Errorf("service lists within the minute: %d more", now-lists)
	}
	passPromTime(s, 61*time.Second)
	if !promAvailable(s) {
		t.Error("not asked again a minute after it ran out of time")
	}
}

// A Prometheus found is kept ten minutes, as before: the shorter time is only for a miss.
func TestPrometheusDiscovery_AFoundServiceIsKeptTenMinutes(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	s := newPromService(cs, nil)
	if !promAvailable(s) {
		t.Fatal("not found")
	}
	srv.become(false, false)
	passPromTime(s, 9*time.Minute+59*time.Second)
	if !promAvailable(s) {
		t.Error("asked again within ten minutes of finding it")
	}
	if lists, _ := srv.counts(); lists != oneRound {
		t.Errorf("service lists within ten minutes = %d, want one discovery (%d)", lists, oneRound)
	}
	passPromTime(s, 2*time.Second)
	if promAvailable(s) {
		t.Error("not asked again ten minutes after finding it")
	}
	if lists, _ := srv.counts(); lists != oneRound+missRound {
		t.Errorf("service lists after ten minutes = %d, want a second discovery (%d)", lists, oneRound+missRound)
	}
}

// Callers that come together once the minute is over start one discovery between them, not one each.
func TestPrometheusDiscovery_CallersAfterTheMinuteShareOneDiscovery(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, false, false)
	s := newPromService(cs, nil)
	if promAvailable(s) {
		t.Fatal("found in a cluster without one")
	}
	srv.become(true, false)
	passPromTime(s, 61*time.Second)
	const callers = 20
	found := make([]bool, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			found[i] = promAvailable(s)
		}()
	}
	wg.Wait()
	for i, ok := range found {
		if !ok {
			t.Errorf("caller %d: not found after the minute", i)
		}
	}
	if lists, _ := srv.counts(); lists != missRound+oneRound {
		t.Errorf("service lists for %d callers = %d, want one more discovery (%d)", callers, lists, missRound+oneRound)
	}
}

// A Service with the prometheus chart's server labels, in a namespace and on a
// port the old probe never looks at, is found first.
func TestPrometheusDiscovery_LabelsFirstAnyNamespaceAnyPort(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	srv.labelled = true
	s := newPromService(cs, nil)
	st := s.PrometheusStatus(context.Background())
	if st["available"] != true || st["endpoint"] != "o11y/prometheus-server:80 (via K8s API proxy)" || st["configured"] != false {
		t.Fatalf("status = %v", st)
	}
	if lists, _ := srv.counts(); lists != 2 {
		t.Fatalf("service lists = %d, want 2 (the first selector found nothing, the second did)", lists)
	}
}

// A Service named in the settings is used without discovery; the status says
// whether it answers.
func TestPrometheusStatus_ConfiguredService(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, true, false)
	s := newPromService(cs, nil)
	b := s.defaultBundle.Load()
	b.promSvc = &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9090}
	st := s.PrometheusStatus(context.Background())
	if st["available"] != true || st["configured"] != true || st["endpoint"] != "monitoring/prometheus:9090 (via K8s API proxy)" {
		t.Fatalf("configured status = %v", st)
	}
	if lists, _ := srv.counts(); lists != 0 {
		t.Fatalf("a named Service must not be discovered: %d lists", lists)
	}
	b.promSvc = &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9999}
	st = s.PrometheusStatus(context.Background())
	if st["available"] != false || !strings.Contains(st["message"].(string), "has no port 9999") {
		t.Fatalf("wrong port status = %v", st)
	}
	b.promSvc = &promServiceInfo{Namespace: "monitoring", Name: "nope", Port: 9090}
	st = s.PrometheusStatus(context.Background())
	if st["available"] != false || !strings.Contains(st["message"].(string), "monitoring/nope:9090") {
		t.Fatalf("missing Service status = %v", st)
	}
}

// The discovery identity is refused services/proxy on a real cluster (view has
// no proxy): a refused /-/healthy must not make a Service that does not exist
// look available.
func TestPrometheusStatus_ConfiguredServiceRefusedProxy(t *testing.T) {
	promDiscoveryEnv(t)
	cs, _ := newPromServer(t, true, true)
	s := newPromService(cs, nil)
	b := s.defaultBundle.Load()
	b.promSvc = &promServiceInfo{Namespace: "monitoring", Name: "nope", Port: 9090}
	if st := s.PrometheusStatus(context.Background()); st["available"] != false {
		t.Fatalf("a missing Service behind a refused proxy = %v", st)
	}
	b.promSvc = &promServiceInfo{Namespace: "monitoring", Name: "prometheus", Port: 9090}
	if st := s.PrometheusStatus(context.Background()); st["available"] != true {
		t.Fatalf("an existing Service behind a refused proxy = %v", st)
	}
}
