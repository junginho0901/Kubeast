package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/discovery"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// probeService is a Service whose requests go as the person, with the breaker on (5 fails), its cluster idc at url;
// the package's options come back after the test.
func probeService(t *testing.T, url string, opts ServiceOptions) *Service {
	t.Helper()
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", url, 1)
	reg := &identityRegistry{info: cluster.Info{ID: idc, Mode: cluster.ModeExternal, KubeconfigBlob: kc}}
	opts.MaxClusters, opts.Impersonation, opts.NoInformers, opts.BreakerFails = 20, true, true, 5
	wasImpersonation, wasOff, wasRates := impersonationEnabled, informersOff, clientRates
	t.Cleanup(func() { impersonationEnabled, informersOff, clientRates = wasImpersonation, wasOff, wasRates })
	s, err := NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// shortProbe gives the sweep's probe d instead of its 5 s until the test ends.
func shortProbe(t *testing.T, d time.Duration) {
	t.Helper()
	was := probeBudget
	probeBudget = d
	t.Cleanup(func() { probeBudget = was })
}

// queued is how many requests wait in l for their token.
func queued(l *turnLimiter) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.waiting()
}

// The sweep's probe reads /version as /health does, behind none of the people's requests: with more of them queued in
// the cluster's turn limiter than a probe's 5 s lets through (one a second), a cluster that answers at once is healthy,
// its breaker stays closed and the sweep ends at once. Before, the probe waited in that queue, its time ended there and
// the sweep opened the breaker and wrote disconnected.
func TestTheHealthProbeWaitsBehindNoOnesRequests(t *testing.T) {
	api := &identityAPI{}
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	s := probeService(t, srv.URL, ServiceOptions{ClientQPS: 1, ClientBurst: 1})
	b, err := s.For(context.Background(), idc)
	if err != nil {
		t.Fatal(err)
	}
	people, ok := b.clientset.CoreV1().RESTClient().GetRateLimiter().(*turnLimiter)
	if !ok {
		t.Fatalf("the people's client limits with %T, want its turn limiter", b.clientset.CoreV1().RESTClient().GetRateLimiter())
	}
	crowd, leave := context.WithCancel(auth.WithPayload(cluster.WithID(context.Background(), idc), auth.TokenPayload{UserID: "u1", Email: "reader@example.com"}))
	var wg sync.WaitGroup
	defer func() { leave(); wg.Wait() }()
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = s.RawRequest(crowd, http.MethodGet, "/api/v1/namespaces")
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for queued(people) < 10 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := queued(people); n < 10 {
		t.Fatalf("%d of the people's requests queued, want 10 or more (a request after them waits 10 s)", n)
	}
	rows := &healthRows{metas: []cluster.Meta{{ID: idc}}, written: map[cluster.ID]string{}}
	start := time.Now()
	NewHealthChecker(s, rows, time.Hour).sweep(context.Background())
	took := time.Since(start)
	if took > time.Second || s.ClusterDown(idc) || rows.written[idc] != "healthy" {
		t.Errorf("a sweep with the people's requests queued: %v, breaker open %v, written %q; want within 1 s, closed, healthy",
			took.Round(time.Millisecond), s.ClusterDown(idc), rows.written[idc])
	}
	if n := versionAsks(api.seenNow()); n != 1 {
		t.Errorf("the sweep asked /version %d times, want once", n)
	}
}

// waitForEnd is a transport of Kubeast's own in front of the cluster's that sends nothing: it waits until its request's
// context ends, as a client-side wait whose turn does not come in the probe's time.
type waitForEnd struct{}

func (waitForEnd) RoundTrip(r *http.Request) (*http.Response, error) {
	<-r.Context().Done()
	return nil, r.Context().Err()
}

// sendAtEnd is a wait of Kubeast's own in front of the cluster's transports that ends once its request's context has,
// then sends the call through them, as a credential plugin that succeeds after the probe's time.
type sendAtEnd struct{ base http.RoundTripper }

func (t sendAtEnd) RoundTrip(r *http.Request) (*http.Response, error) {
	<-r.Context().Done()
	return t.base.RoundTrip(r)
}

// failingPlugin is a credential plugin in front of the cluster's transports that fails, with client-go's words, at
// once or once its request's context has ended: client-go runs the plugin apart from that context, so one slower than
// the probe's time, or one waiting behind the people's requests that run it, fails after it.
type failingPlugin struct{ late bool }

func (p failingPlugin) RoundTrip(r *http.Request) (*http.Response, error) {
	if p.late {
		<-r.Context().Done()
	}
	return nil, errors.New("getting credentials: exec: executable aws-iam-authenticator failed with exit code 1")
}

// frontVersionClient gives b's version client front in front of the cluster's transports.
func frontVersionClient(t *testing.T, b *clientBundle, front func(http.RoundTripper) http.RoundTripper) {
	t.Helper()
	cfg := rest.CopyConfig(b.restConfig)
	cfg.QPS, cfg.RateLimiter = -1, nil
	cfg.Wrap(front)
	own, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b.ownVersion = own
}

// A probe whose call did not go out gives no verdict: a wait of Kubeast's own that outlasts the probe's time, whether
// the call then goes out or not, and a sweep that is stopping, leave the breaker as it was, open or closed, and write no
// status. The first two say so once in the log; the last says nothing.
func TestAProbeWhoseCallDidNotGoOutGivesNoVerdict(t *testing.T) {
	shortProbe(t, 200*time.Millisecond)
	for name, c := range map[string]struct {
		front    func(http.RoundTripper) http.RoundTripper // in front of the version client's transports
		stopping bool                                      // the sweep's context has ended
		logged   int
	}{
		"a wait of Kubeast's own past the probe's time": {
			front: func(http.RoundTripper) http.RoundTripper { return waitForEnd{} }, logged: 1},
		"a wait of Kubeast's own past the probe's time, then the call": {
			front: func(rt http.RoundTripper) http.RoundTripper { return sendAtEnd{base: rt} }, logged: 1},
		"the sweep stopping": {stopping: true},
	} {
		for _, open := range []bool{false, true} {
			logs := captureLogs(t)
			api := &identityAPI{}
			srv := httptest.NewServer(api)
			s := probeService(t, srv.URL, ServiceOptions{})
			b, err := s.For(context.Background(), idc)
			if err != nil {
				t.Fatal(err)
			}
			if c.front != nil {
				frontVersionClient(t, b, c.front)
			}
			s.health.setOpen(idc, open)
			ctx, stop := context.WithCancel(context.Background())
			if c.stopping {
				stop()
			}
			rows := &healthRows{metas: []cluster.Meta{{ID: idc}}, written: map[cluster.ID]string{}}
			NewHealthChecker(s, rows, time.Hour).sweep(ctx)
			stop()
			srv.Close()
			lines := logs.take()
			if s.ClusterDown(idc) != open || len(rows.written) != 0 {
				t.Errorf("%s, breaker open %v: open %v after the sweep, written %v; want it as it was and nothing written",
					name, open, s.ClusterDown(idc), rows.written)
			}
			if n := strings.Count(lines, "keeping the last verdict"); n != c.logged || (n > 0 && !strings.Contains(lines, "id="+string(idc))) {
				t.Errorf("%s, breaker open %v: %d log lines naming the probe, want %d naming the cluster:\n%s", name, open, n, c.logged, lines)
			}
			if c.front != nil && versionAsks(api.seenNow()) != 0 {
				t.Errorf("%s: /version reached the cluster", name)
			}
		}
	}
}

// A credential plugin that fails fails the probe however long it took, at once or after the probe's time: the
// breaker opens and disconnected is written, from a breaker closed and from one open, and no line says the call did
// not go out.
func TestACredentialPluginThatFailsFailsTheProbe(t *testing.T) {
	shortProbe(t, 200*time.Millisecond)
	for name, late := range map[string]bool{"at once": false, "after the probe's time": true} {
		for _, open := range []bool{false, true} {
			logs := captureLogs(t)
			api := &identityAPI{}
			srv := httptest.NewServer(api)
			s := probeService(t, srv.URL, ServiceOptions{})
			b, err := s.For(context.Background(), idc)
			if err != nil {
				t.Fatal(err)
			}
			frontVersionClient(t, b, func(http.RoundTripper) http.RoundTripper { return failingPlugin{late: late} })
			s.health.setOpen(idc, open)
			rows := &healthRows{metas: []cluster.Meta{{ID: idc}}, written: map[cluster.ID]string{}}
			NewHealthChecker(s, rows, time.Hour).sweep(context.Background())
			srv.Close()
			if !s.ClusterDown(idc) || rows.written[idc] != "disconnected" {
				t.Errorf("a plugin failing %s, breaker open %v: open %v, written %q after the sweep; want open, disconnected",
					name, open, s.ClusterDown(idc), rows.written[idc])
			}
			if lines := logs.take(); strings.Contains(lines, "keeping the last verdict") {
				t.Errorf("a plugin failing %s, breaker open %v: logged as a call that did not go out:\n%s", name, open, lines)
			}
			if versionAsks(api.seenNow()) != 0 {
				t.Errorf("a plugin failing %s: /version reached the cluster", name)
			}
		}
	}
}

// What the probe's call got decides: the API server's version is healthy and closes the breaker; another answer of the
// API server (a 404, a refused credential, a 503 or 500 of its own, each with its Audit-ID) closes it too, as a trial's
// answer does, and writes disconnected; a cluster that refuses the connection, does not end the TLS handshake within
// the probe's time, has a proxy in front answer /version with an error status, or takes the call and answers nothing
// within the probe's time opens it and writes disconnected. Each from a breaker closed and from one open.
func TestTheProbeReadsWhatItsCallGotFromTheCluster(t *testing.T) {
	shortProbe(t, 300*time.Millisecond)
	refused := httptest.NewServer(http.NotFoundHandler())
	refusedURL := refused.URL
	refused.Close()
	silent := silentListener(t)
	for name, c := range map[string]struct {
		status  int           // /version's answer, 0 = the version
		inFront bool          // a proxy in front of the API server answers /version, with no Audit-ID
		delay   time.Duration // before the answer
		url     string        // the cluster's address, "" = the stand-in API server
		down    bool
		wrote   string
	}{
		"the version":                       {wrote: "healthy"},
		"404":                               {status: http.StatusNotFound, wrote: "disconnected"},
		"401":                               {status: http.StatusUnauthorized, wrote: "disconnected"},
		"503":                               {status: http.StatusServiceUnavailable, wrote: "disconnected"},
		"500":                               {status: http.StatusInternalServerError, wrote: "disconnected"},
		"a proxy's 404":                     {status: http.StatusNotFound, inFront: true, down: true, wrote: "disconnected"},
		"a proxy's 502":                     {status: http.StatusBadGateway, inFront: true, down: true, wrote: "disconnected"},
		"no answer within the probe's time": {delay: 2 * time.Second, down: true, wrote: "disconnected"},
		"refused":                           {url: refusedURL, down: true, wrote: "disconnected"},
		"a TLS handshake that does not end": {url: silent, down: true, wrote: "disconnected"},
	} {
		for _, open := range []bool{false, true} {
			api := &identityAPI{versionInFront: c.inFront}
			api.answerVersion("", c.status)
			api.slowVersion(c.delay)
			srv := httptest.NewServer(api)
			url := c.url
			if url == "" {
				url = srv.URL
			}
			s := probeService(t, url, ServiceOptions{})
			s.health.setOpen(idc, open)
			rows := &healthRows{metas: []cluster.Meta{{ID: idc}}, written: map[cluster.ID]string{}}
			NewHealthChecker(s, rows, time.Hour).sweep(context.Background())
			srv.Close()
			if s.ClusterDown(idc) != c.down || rows.written[idc] != c.wrote {
				t.Errorf("%s, breaker open %v: open %v, written %q after the sweep; want open %v, %q",
					name, open, s.ClusterDown(idc), rows.written[idc], c.down, c.wrote)
			}
		}
	}
}
