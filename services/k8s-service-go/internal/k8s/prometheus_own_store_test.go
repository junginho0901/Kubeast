package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

const storeAllowEnv = "CLUSTER_STORE_ALLOWED_HOSTS"

func healthyStore(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	hits := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

// redirectingStore answers every path with a redirect to where.
func redirectingStore(t *testing.T, where string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, where, http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// underLocalhost is the server's address by another name for the same machine.
func underLocalhost(t *testing.T, srv *httptest.Server, path string) string {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return "http://localhost:" + u.Port() + path
}

func TestOwnStoreIsNotAskedAtTheServiceItself(t *testing.T) {
	srv, hits := healthyStore(t)
	ok, reason := externalFromInfo(cluster.Info{PrometheusURL: srv.URL}).healthy(context.Background())
	if ok || !strings.Contains(reason, "features.clusterStoreAllowedHosts") {
		t.Errorf("healthy = %v %q, want a refusal naming the setting", ok, reason)
	}
	if hits.Load() != 0 {
		t.Errorf("the address was called %d times", hits.Load())
	}
}

func TestOwnStoreOnTheAllowListIsAsked(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1")
	srv, hits := healthyStore(t)
	if ok, reason := externalFromInfo(cluster.Info{PrometheusURL: srv.URL}).healthy(context.Background()); !ok {
		t.Errorf("healthy = false %q", reason)
	}
	if hits.Load() != 1 {
		t.Errorf("hits = %d", hits.Load())
	}
}

func TestOwnStoreAtAMetadataAddressIsNotCalled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	ok, reason := externalFromInfo(cluster.Info{PrometheusURL: "http://169.254.169.254"}).healthy(ctx)
	if ok || !strings.Contains(reason, "metadata") {
		t.Errorf("healthy = %v %q, want the metadata refusal", ok, reason)
	}
}

func TestOwnStoreRedirectToAnotherHostIsNotFollowed(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1,localhost")
	target, hits := healthyStore(t)
	front := redirectingStore(t, underLocalhost(t, target, "/-/healthy"))
	ok, reason := externalFromInfo(cluster.Info{PrometheusURL: front.URL}).healthy(context.Background())
	if ok || !strings.Contains(reason, "another host") {
		t.Errorf("healthy = %v %q, want the redirect named", ok, reason)
	}
	if hits.Load() != 0 {
		t.Errorf("the other host was called %d times", hits.Load())
	}
}

func TestOwnStoreRedirectOnItsOwnHostIsFollowed(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1")
	mux := http.NewServeMux()
	mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/prom/-/healthy", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/prom/-/healthy", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	if ok, reason := externalFromInfo(cluster.Info{PrometheusURL: srv.URL}).healthy(context.Background()); !ok {
		t.Errorf("healthy = false %q", reason)
	}
}

func TestOwnStoreKeepsItsAuthorizationHeader(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1")
	var got atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	ext := externalFromInfo(cluster.Info{PrometheusURL: srv.URL, PrometheusAuthHeader: "Bearer not-a-real-token"})
	if ok, reason := ext.healthy(context.Background()); !ok {
		t.Fatalf("healthy = false %q", reason)
	}
	if got.Load() != "Bearer not-a-real-token" {
		t.Errorf("Authorization = %v", got.Load())
	}
}

// The chart's own URL is the installer's, not something a cluster admin typed.
func TestDeploymentWideStoreIsLeftAsItWas(t *testing.T) {
	target, hits := healthyStore(t)
	front := redirectingStore(t, underLocalhost(t, target, "/-/healthy"))
	t.Setenv("PROMETHEUS_URL", front.URL)
	ext := externalFromInfo(cluster.Info{})
	if ok, reason := ext.healthy(context.Background()); !ok {
		t.Errorf("healthy = false %q", reason)
	}
	if hits.Load() != 1 {
		t.Errorf("target hits = %d", hits.Load())
	}
}

func TestOwnLogStoreIsMarkedAsRegistered(t *testing.T) {
	if store := logStoreFromInfo(cluster.Info{LogSearchURL: "http://loki:3100"}); store == nil || !store.Registered {
		t.Errorf("store = %+v", store)
	}
}
