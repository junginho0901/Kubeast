package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
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
}

func (p *promServer) counts() (lists, queries int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lists, p.queries
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
			ps.mu.Unlock()
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
	t.Cleanup(srv.Close)
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
