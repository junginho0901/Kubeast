package logsearch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const storeAllowEnv = "CLUSTER_STORE_ALLOWED_HOSTS"

func lokiHealthy(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	hits := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

func TestRegisteredStoreIsNotAskedAtTheServiceItself(t *testing.T) {
	srv, hits := lokiHealthy(t)
	ok, reason := newLoki(Config{Timeout: time.Second}).healthy(context.Background(), Store{URL: srv.URL, Registered: true})
	if ok || !strings.Contains(reason, "features.clusterStoreAllowedHosts") {
		t.Errorf("healthy = %v %q, want a refusal naming the setting", ok, reason)
	}
	if hits.Load() != 0 {
		t.Errorf("called %d times", hits.Load())
	}
}

func TestRegisteredStoreOnTheListIsAsked(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1")
	srv, hits := lokiHealthy(t)
	if ok, reason := newLoki(Config{Timeout: time.Second}).healthy(context.Background(), Store{URL: srv.URL, Registered: true}); !ok {
		t.Errorf("healthy = false %q", reason)
	}
	if hits.Load() != 1 {
		t.Errorf("hits = %d", hits.Load())
	}
}

func TestRegisteredStoreRedirectToAnotherHostIsNotFollowed(t *testing.T) {
	t.Setenv(storeAllowEnv, "127.0.0.1,localhost")
	target, hits := lokiHealthy(t)
	u, err := url.Parse(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://localhost:"+u.Port()+r.URL.RequestURI(), http.StatusFound)
	}))
	t.Cleanup(front.Close)
	ok, reason := newLoki(Config{Timeout: time.Second}).healthy(context.Background(), Store{URL: front.URL, Registered: true})
	if ok || !strings.Contains(reason, "another host") {
		t.Errorf("healthy = %v %q, want the redirect named", ok, reason)
	}
	if hits.Load() != 0 {
		t.Errorf("the other host was called %d times", hits.Load())
	}
}

// The chart's own URL is the installer's, not something a cluster admin typed.
func TestDeploymentWideStoreAnswersAsBefore(t *testing.T) {
	srv, _ := lokiHealthy(t)
	if ok, reason := newLoki(Config{Timeout: time.Second}).healthy(context.Background(), Store{URL: srv.URL}); !ok {
		t.Errorf("healthy = false %q", reason)
	}
}
