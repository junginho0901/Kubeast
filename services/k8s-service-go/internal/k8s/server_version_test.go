package k8s

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// versionAPI answers /version as an API server does and counts the asks.
type versionAPI struct {
	gitVersion string
	status     int
	delay      time.Duration
	hold       chan struct{} // when set, an ask waits for it to close
	asks       atomic.Int32
	mu         sync.Mutex
	asUsers    []string
}

func (a *versionAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		a.asks.Add(1)
		a.mu.Lock()
		a.asUsers = append(a.asUsers, r.Header.Get(auth.HeaderImpersonateUser))
		a.mu.Unlock()
		if a.hold != nil {
			select {
			case <-a.hold:
			case <-r.Context().Done():
				return
			}
		}
		time.Sleep(a.delay)
		if a.status != 0 {
			w.WriteHeader(a.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"major":"1","minor":"35","gitVersion":%q}`, a.gitVersion)
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, discovery: cs.Discovery()})
	return s
}

// A crowd opening their screens at once, each asking the features, asks the cluster its version about once.
func TestFeaturesOfACrowdAskTheServerVersionAboutOnce(t *testing.T) {
	api := &versionAPI{gitVersion: "v1.35.2", delay: 30 * time.Millisecond}
	s := api.service(t)
	var wg sync.WaitGroup
	var unsupported atomic.Int32
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if !s.ServerSupportsResize(callerCtx(fmt.Sprintf("user-%d@example.com", i))) {
				unsupported.Add(1)
			}
		}(i)
	}
	wg.Wait()
	for i := 0; i < 20; i++ {
		if !s.ServerSupportsResize(callerCtx("late@example.com")) {
			unsupported.Add(1)
		}
	}
	if n := unsupported.Load(); n != 0 {
		t.Errorf("%d of 70 answers said a 1.35 server cannot resize", n)
	}
	if n := api.asks.Load(); n > 2 {
		t.Errorf("70 feature reads asked the cluster its version %d times, want at most 2", n)
	}
}

// The version is the cluster's, asked as Kubeast itself: no caller's identity goes with it.
func TestServerVersionIsAskedWithoutTheCallersIdentity(t *testing.T) {
	api := &versionAPI{gitVersion: "v1.34.1"}
	s := api.service(t)
	if s.ServerSupportsResize(callerCtx("someone@example.com")) {
		t.Error("a 1.34 server was said to support resize")
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	for _, user := range api.asUsers {
		if user != "" {
			t.Errorf("/version was asked as %q", user)
		}
	}
	if len(api.asUsers) != 1 {
		t.Errorf("asks = %d, want 1", len(api.asUsers))
	}
}

// A caller who leaves does not stay waiting on the cluster's answer.
func TestServerVersionAskEndsWhenTheCallerLeaves(t *testing.T) {
	api := &versionAPI{gitVersion: "v1.35.0", hold: make(chan struct{})}
	s := api.service(t)
	release := time.AfterFunc(3*time.Second, func() { close(api.hold) })
	t.Cleanup(func() { release.Stop() })
	ctx, cancel := context.WithTimeout(callerCtx("leaving@example.com"), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := s.ServerSupportsResize(ctx)
	if took := time.Since(start); took > time.Second {
		t.Errorf("the call returned %v after its caller left, want under 1s", took.Round(time.Millisecond))
	}
	if got {
		t.Error("an unanswered version was said to support resize")
	}
}

// A failed ask is not remembered: the next caller asks again and gets the answer.
func TestServerVersionFailureIsAskedAgain(t *testing.T) {
	api := &versionAPI{gitVersion: "v1.35.0", status: http.StatusServiceUnavailable}
	s := api.service(t)
	if s.ServerSupportsResize(callerCtx("a@example.com")) {
		t.Error("a failed version ask was said to support resize")
	}
	api.status = 0
	if !s.ServerSupportsResize(callerCtx("b@example.com")) {
		t.Error("the ask after a failure did not reach the cluster's answer")
	}
	if n := api.asks.Load(); n != 2 {
		t.Errorf("asks = %d, want 2", n)
	}
}
