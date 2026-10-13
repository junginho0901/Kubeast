package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	mu         sync.Mutex
	lists      int
	queries    int
}

func (p *promServer) counts() (lists, queries int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lists, p.queries
}

func newPromServer(t *testing.T, found, healthy403 bool) (*kubernetes.Clientset, *promServer) {
	t.Helper()
	ps := &promServer{found: found, healthy403: healthy403}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/services"):
			ps.mu.Lock()
			ps.lists++
			ps.mu.Unlock()
			if ps.found && p == "/api/v1/namespaces/monitoring/services" {
				_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"prometheus","namespace":"monitoring"},"spec":{"ports":[{"name":"web","port":9090}]}}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"items":[]}`))
		case p == "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/-/healthy":
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
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
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
}

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
	if lists, _ := view.counts(); lists != 7 {
		t.Fatalf("service lists = %d, want one round of 7 namespaces", lists)
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
	if lists, _ := srv.counts(); lists != 7 {
		t.Fatalf("service lists = %d, want 7 (bundle clientset stands in for the cache identity)", lists)
	}
}

// No Service anywhere: not found, probed once per TTL.
func TestPrometheusDiscovery_NotFoundProbedOnce(t *testing.T) {
	promDiscoveryEnv(t)
	cs, srv := newPromServer(t, false, false)
	s := newPromService(cs, nil)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if st := s.PrometheusStatus(ctx); st["available"] != false || st["message"] != "Prometheus not found in target cluster" {
			t.Fatalf("call %d: status = %v", i+1, st)
		}
	}
	if lists, _ := srv.counts(); lists != 7 {
		t.Fatalf("service lists = %d, want one round of 7", lists)
	}
}
