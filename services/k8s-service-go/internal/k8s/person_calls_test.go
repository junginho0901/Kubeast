package k8s

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type identitySeen struct{ method, path, user string }

// identityAPI answers as an API server enough for the overview, discovery, the cluster config, hygiene and a watch,
// and keeps whom each request came as.
type identityAPI struct {
	mu            sync.Mutex
	seen          []identitySeen
	versionDelay  time.Duration
	gitVersion    string // "" answers v1.35.0
	versionStatus int    // 0 answers 200
}

func (a *identityAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.seen = append(a.seen, identitySeen{r.Method, r.URL.Path, r.Header.Get(auth.HeaderImpersonateUser)})
	delay, gitVersion, status := a.versionDelay, a.gitVersion, a.versionStatus
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	switch {
	case p == "/version":
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		if gitVersion == "" {
			gitVersion = "v1.35.0"
		}
		_, _ = fmt.Fprintf(w, `{"major":"1","minor":"35","gitVersion":%q}`, gitVersion)
	case p == "/api":
		_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[{"clientCIDR":"0.0.0.0/0","serverAddress":"127.0.0.1"}]}`))
	case p == "/apis":
		_, _ = w.Write([]byte(`{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}],"preferredVersion":{"groupVersion":"apps/v1","version":"v1"}}]}`))
	case p == "/api/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]},{"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["get","list","watch"]}]}`))
	case p == "/apis/apps/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"apps/v1","resources":[{"name":"deployments","singularName":"deployment","namespaced":true,"kind":"Deployment","verbs":["get","list","watch"]}]}`))
	case p == "/apis/scheduling.k8s.io/v1alpha2":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"scheduling.k8s.io/v1alpha2","resources":[{"name":"workloads","singularName":"workload","namespaced":true,"kind":"Workload","verbs":["get","list"]}]}`))
	case p == "/apis/scheduling.k8s.io/v1alpha2/workloads":
		_, _ = w.Write([]byte(`{"apiVersion":"scheduling.k8s.io/v1alpha2","kind":"WorkloadList","metadata":{"resourceVersion":"1"},"items":[]}`))
	case strings.HasPrefix(p, "/apis/") && strings.Count(p, "/") == 3:
		http.NotFound(w, r) // a group version this server does not serve
	case strings.HasSuffix(p, "/selfsubjectaccessreviews"):
		_, _ = w.Write([]byte(`{"apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","status":{"allowed":true}}`))
	case r.URL.Query().Get("watch") == "true":
		w.WriteHeader(http.StatusOK) // a watch that ends at once
	default:
		_, _ = w.Write([]byte(`{"metadata":{"resourceVersion":"1"},"items":[]}`))
	}
}

func (a *identityAPI) take() []identitySeen {
	a.mu.Lock()
	defer a.mu.Unlock()
	seen := a.seen
	a.seen = nil
	return seen
}

func (a *identityAPI) seenNow() []identitySeen {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]identitySeen(nil), a.seen...)
}

func (a *identityAPI) slowVersion(d time.Duration) {
	a.mu.Lock()
	a.versionDelay = d
	a.mu.Unlock()
}

func (a *identityAPI) answerVersion(gitVersion string, status int) {
	a.mu.Lock()
	a.gitVersion, a.versionStatus = gitVersion, status
	a.mu.Unlock()
}

// versionAsks is how many of seen asked /version.
func versionAsks(seen []identitySeen) (n int) {
	for _, r := range seen {
		if r.path == "/version" {
			n++
		}
	}
	return n
}

// syncBuffer is what slog writes into while a test reads it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) take() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.b.String()
	s.b.Reset()
	return out
}

// captureLogs sends slog's default logger to a buffer until the test ends.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })
	return buf
}

// idc is the cluster these tests read, a name no other test uses, so the refusals counted in the log are theirs.
const idc cluster.ID = "person-calls"

// refusals counts the log lines of requests to idc refused for naming no one.
func refusals(lines string) (n int) {
	for _, l := range strings.Split(lines, "\n") {
		if strings.Contains(l, "cluster request with no person refused") && strings.Contains(l, "cluster="+string(idc)) {
			n++
		}
	}
	return n
}

// identityRegistry holds the one cluster idc; its default can be made slow to name, or to panic, after the start.
type identityRegistry struct {
	info         cluster.Info
	defaultTakes atomic.Int64 // nanoseconds
	panics       atomic.Bool
}

func (r *identityRegistry) List(context.Context) ([]cluster.Info, error) {
	return []cluster.Info{r.info}, nil
}
func (r *identityRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	if id != r.info.ID {
		return nil, cluster.ErrNotFound
	}
	info := r.info
	return &info, nil
}
func (r *identityRegistry) Default(context.Context) (cluster.ID, error) {
	if r.panics.Load() {
		panic("the registry broke")
	}
	time.Sleep(time.Duration(r.defaultTakes.Load()))
	return r.info.ID, nil
}

// identityService is a Service on api with ServiceOptions.Impersonation and no overview informers, reading the cluster idc.
func identityService(t *testing.T, api *identityAPI) *Service {
	s, _ := identityServiceWith(t, api, ServiceOptions{})
	return s
}

// identityServiceWith is identityService with opts (its rates) and the registry it reads; the package's options come
// back after the test.
func identityServiceWith(t *testing.T, api *identityAPI, opts ServiceOptions) (*Service, *identityRegistry) {
	t.Helper()
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	reg := &identityRegistry{info: cluster.Info{ID: idc, Mode: cluster.ModeExternal, KubeconfigBlob: kc}}
	opts.MaxClusters, opts.Impersonation, opts.NoInformers = 20, true, true
	wasImpersonation, wasOff, wasRates := impersonationEnabled, informersOff, clientRates
	s, err := NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { impersonationEnabled, informersOff, clientRates = wasImpersonation, wasOff, wasRates })
	return s, reg
}

// Every request a person's screen makes reaches the cluster as that person, but the reads Kubeast keeps once for
// everyone (the version, the cluster's discovery lists, the served versions of a kind) and its health reads, which go
// as Kubeast itself; a request whose context names no one is not sent, and says so in the log.
func TestEveryUserCallCarriesThePerson(t *testing.T) {
	logs := captureLogs(t)
	api := &identityAPI{}
	s := identityService(t, api)
	const person = "reader@example.com"
	callerCtx := auth.WithPayload(cluster.WithID(context.Background(), idc), auth.TokenPayload{UserID: "u1", Email: person, Roles: map[string]string{string(idc): "Read"}})
	pinned, err := s.UserRESTConfigFor(callerCtx)
	if err != nil {
		t.Fatal(err)
	}
	// each step that reads the version asks it again, so its own /version is seen
	forgetVersion := func() {
		b := s.defaultClientBundle()
		b.version.mu.Lock()
		b.version.value = nil
		b.version.mu.Unlock()
	}
	rows := &healthRows{metas: []cluster.Meta{{ID: idc}}, written: map[cluster.ID]string{}}
	hc := NewHealthChecker(s, rows, time.Hour)
	discoveryReads := []string{"/api", "/apis", "/api/v1", "/apis/apps/v1"}
	for _, step := range []struct {
		name   string
		run    func(ctx context.Context) error
		person []string // paths that must reach the cluster as the person
		own    []string // paths that must reach it as Kubeast itself; every other request goes as the person
	}{
		{name: "overview", person: []string{"/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", "/api/v1/nodes"}, own: []string{"/version"},
			run: func(ctx context.Context) error {
				ov, err := s.GetClusterOverview(ctx)
				if err == nil && ov["cluster_version"] != "v1.35.0" {
					err = errors.New("cluster_version " + toString(ov["cluster_version"]))
				}
				return err
			}},
		{name: "api-resources", own: discoveryReads, run: func(ctx context.Context) error { _, err := s.GetAPIResources(ctx); return err }},
		{name: "cluster-config", person: []string{"/api", "/apis"}, own: []string{"/version"}, run: func(ctx context.Context) error {
			cfg, err := s.GetClusterConfig(ctx)
			if err != nil {
				return err
			}
			if v, _ := cfg["version"].(map[string]interface{}); v["git_version"] != "v1.35.0" {
				return errors.New("no version in the cluster config")
			}
			if groups, _ := cfg["api_groups"].([]string); !slices.Contains(groups, "apps") {
				return errors.New("no api_groups in the cluster config")
			}
			return nil
		}},
		{name: "ResolveGVR", own: []string{"/api", "/apis", "/apis/apps/v1"}, run: func(ctx context.Context) error {
			if _, ok := s.ResolveGVR(ctx, "apps", "deployments"); !ok {
				return errors.New("apps/deployments not resolved")
			}
			return nil
		}},
		{name: "hygiene", person: []string{"/apis/scheduling.k8s.io/v1alpha2", "/apis/scheduling.k8s.io/v1alpha2/workloads", "/api/v1/pods"}, own: []string{"/version"},
			run: func(ctx context.Context) error {
				rep, err := s.CollectHygiene(ctx, HygieneOptions{})
				if err == nil && rep.ServerVersion != "v1.35.0" {
					err = errors.New("hygiene server_version " + rep.ServerVersion)
				}
				return err
			}},
		{name: "watch", person: []string{"/apis/apps/v1/namespaces/shop/deployments"}, run: func(ctx context.Context) error {
			w, err := s.DynamicForCtx(ctx).Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).Namespace("shop").Watch(ctx, metav1.ListOptions{})
			if err == nil {
				w.Stop()
			}
			return err
		}},
		{name: "server version", own: []string{"/version"}, run: func(ctx context.Context) error {
			if !s.ServerSupportsResize(ctx) {
				return errors.New("a 1.35 server was said not to resize")
			}
			return nil
		}},
		{name: "a pinned config's request with its own context", person: []string{"/api/v1/namespaces/shop/configmaps"}, run: func(context.Context) error {
			cs, err := kubernetes.NewForConfig(pinned)
			if err != nil {
				return err
			}
			_, err = cs.CoreV1().ConfigMaps("shop").List(context.Background(), metav1.ListOptions{})
			return err
		}},
		{name: "/health", own: []string{"/version"}, run: func(context.Context) error { return s.HealthCheck(context.Background()) }},
		{name: "health checker probe and sweep", own: []string{"/version"}, run: func(context.Context) error {
			if !hc.probe(context.Background(), idc) {
				return errors.New("the probe failed")
			}
			hc.sweep(context.Background())
			if s.ClusterDown(idc) || rows.written[idc] != "healthy" {
				return errors.New("the sweep marked the cluster down: " + rows.written[idc])
			}
			return nil
		}},
	} {
		forgetVersion()
		api.take()
		logs.take()
		if err := step.run(callerCtx); err != nil {
			t.Errorf("%s: %v", step.name, err)
		}
		seen := api.take()
		if n := refusals(logs.take()); n != 0 {
			t.Errorf("%s: %d requests were refused for naming no one", step.name, n)
		}
		arrived := map[identitySeen]bool{}
		for _, r := range seen {
			arrived[identitySeen{path: r.path, user: r.user}] = true
			if r.user != person && !(r.user == "" && slices.Contains(step.own, r.path)) {
				t.Errorf("%s: %s %s went as %q", step.name, r.method, r.path, r.user)
			}
		}
		for _, p := range step.person {
			if !arrived[identitySeen{path: p, user: person}] {
				t.Errorf("%s: %s did not reach the cluster as the person", step.name, p)
			}
		}
		for _, p := range step.own {
			if !arrived[identitySeen{path: p}] {
				t.Errorf("%s: %s did not reach the cluster as Kubeast itself", step.name, p)
			}
		}
	}

	bare := cluster.WithID(context.Background(), idc)
	if _, _, err := s.RawRequest(bare, "GET", "/version"); !errors.Is(err, auth.ErrNoPerson) {
		t.Errorf("a request naming no one: err %v, want ErrNoPerson", err)
	}
	if seen := api.take(); len(seen) != 0 {
		t.Errorf("a request naming no one reached the cluster: %+v", seen)
	}
	if lines := logs.take(); refusals(lines) != 1 || !strings.Contains(lines, "path=/version") {
		t.Errorf("a request naming no one: log %q, want one refusal naming /version", lines)
	}
	cfg, err := s.GetClusterConfig(bare)
	if err != nil || cfg["api_groups"] != nil {
		t.Errorf("cluster-config naming no one: %v %+v, want no API groups", err, cfg)
	}
	for _, r := range api.take() {
		if r.user != "" || r.path != "/version" {
			t.Errorf("cluster-config naming no one sent %s %s as %q", r.method, r.path, r.user)
		}
	}
}

// /health's read of the default cluster is one for every caller: a crowd asking at once and the calls after it within
// healthReadEvery cost one GET /version, as Kubeast itself; past that age the next call reads again. A failure stands as
// long, and the read ends within healthReadBudget whatever the API server does.
func TestHealthReadIsOneForEveryCallerAndShort(t *testing.T) {
	api := &identityAPI{}
	s := identityService(t, api)
	ageHealthRead := func() {
		s.healthRead.mu.Lock()
		s.healthRead.at = time.Now().Add(-healthReadEvery - time.Second)
		s.healthRead.mu.Unlock()
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.HealthCheck(context.Background()); err != nil {
				t.Errorf("a crowd's /health: %v", err)
			}
		}()
	}
	wg.Wait()
	for i := 0; i < 20; i++ {
		if err := s.HealthCheck(context.Background()); err != nil {
			t.Fatalf("call %d after the crowd: %v", i, err)
		}
	}
	if seen := api.take(); len(seen) != 1 || seen[0].path != "/version" || seen[0].user != "" {
		t.Errorf("70 /health calls asked %+v, want one /version as Kubeast itself", seen)
	}

	ageHealthRead()
	api.slowVersion(time.Second) // slow but answering: within the budget
	if err := s.HealthCheck(context.Background()); err != nil {
		t.Errorf("past healthReadEvery, a cluster answering in 1 s: %v", err)
	}
	if seen := api.take(); len(seen) != 1 {
		t.Errorf("past healthReadEvery: asked %d times, want once", len(seen))
	}

	ageHealthRead()
	api.slowVersion(5 * time.Second) // not answering
	start := time.Now()
	err := s.HealthCheck(context.Background())
	if took := time.Since(start); err == nil || took > 2*time.Second {
		t.Errorf("a cluster not answering: %v after %v, want an error within 2 s", err, took.Round(time.Millisecond))
	}
	api.take()
	api.slowVersion(0)
	if err := s.HealthCheck(context.Background()); err == nil {
		t.Error("the failure did not stand for healthReadEvery")
	}
	if seen := api.take(); len(seen) != 0 {
		t.Errorf("within healthReadEvery of a failure: asked %d times, want none", len(seen))
	}
}

// A screen's version is at most shownVersionTTL old, so an upgrade shows soon; the features keep theirs serverVersionTTL.
// An ask that fails gives the last version known.
func TestShownVersionIsShortLivedAndKeepsTheLastOnAFailure(t *testing.T) {
	api := &identityAPI{}
	s := identityService(t, api)
	b := s.defaultClientBundle()
	age := func(d time.Duration) {
		b.version.mu.Lock()
		b.version.at = time.Now().Add(-d)
		b.version.mu.Unlock()
	}
	api.answerVersion("v1.34.2", 0)
	if v, err := s.clusterVersion(context.Background()); err != nil || v.GitVersion != "v1.34.2" {
		t.Fatalf("first read: %v %v", v, err)
	}
	api.answerVersion("v1.35.0", 0) // the cluster is upgraded
	age(shownVersionTTL - 5*time.Second)
	if v, _ := s.clusterVersion(context.Background()); v.GitVersion != "v1.34.2" {
		t.Errorf("within shownVersionTTL: %s, want the read kept", v.GitVersion)
	}
	age(shownVersionTTL + time.Second)
	if got := b.serverVersion(context.Background()); got != "v1.34.2" {
		t.Errorf("the features past shownVersionTTL: %s, want the read kept for serverVersionTTL", got)
	}
	if n := versionAsks(api.take()); n != 1 {
		t.Errorf("asked %d times before shownVersionTTL passed for a screen, want only the first", n)
	}
	if v, _ := s.clusterVersion(context.Background()); v.GitVersion != "v1.35.0" {
		t.Errorf("past shownVersionTTL: %s, want the version asked again", v.GitVersion)
	}
	api.answerVersion("", http.StatusServiceUnavailable)
	age(serverVersionTTL + time.Second)
	if v, err := s.clusterVersion(context.Background()); err != nil || v.GitVersion != "v1.35.0" {
		t.Errorf("an ask that failed: %v %v, want the last version known", v, err)
	}
	if n := versionAsks(api.take()); n != 2 {
		t.Errorf("asked %d times after shownVersionTTL and the failure, want 2", n)
	}
}

// The overview read from the informers shows the version the cluster config shows: at most shownVersionTTL old.
func TestTheInformerOverviewShowsAVersionAtMostShownVersionTTLOld(t *testing.T) {
	api := &identityAPI{}
	srv := httptest.NewServer(api)
	defer srv.Close()
	s := &Service{}
	b := &clientBundle{cacheClient: fake.NewSimpleClientset(overviewObjects()...), discovery: discovery.NewDiscoveryClientForConfigOrDie(&rest.Config{Host: srv.URL})}
	b.version.value, b.version.at = &version.Info{GitVersion: "v1.34.2"}, time.Now().Add(-shownVersionTTL-time.Second)
	s.defaultBundle.Store(b)
	t.Cleanup(func() { _ = b.Close() })
	ov, err := s.GetClusterOverview(context.Background())
	if err != nil || ov["cluster_version"] != "v1.35.0" {
		t.Errorf("overview from informers: %v %v, want the version read again past shownVersionTTL", ov["cluster_version"], err)
	}
}

// Dropping a cluster (Invalidate, another replica's notice, a changed config version) forgets its breaker: the cluster
// built again is asked, not answered 503 until the next health sweep.
func TestDroppingAClusterForgetsItsBreaker(t *testing.T) {
	api := &identityAPI{}
	s := identityService(t, api)
	for name, drop := range map[string]func(){
		"Invalidate":  func() { s.Invalidate(idc) },
		"DropCluster": func() { s.DropCluster(idc) },
		"DropStale":   func() { s.DropStale(idc, s.ClusterVersions()[idc]) },
	} {
		if _, err := s.For(context.Background(), idc); err != nil {
			t.Fatal(err)
		}
		s.health.setOpen(idc, true)
		drop()
		if s.ClusterDown(idc) {
			t.Errorf("%s: the breaker stayed open", name)
		}
	}
}

// /health's read waits behind no one: with the people's requests queued in the cluster's turn limiter (one a second)
// it still answers within its budget.
func TestHealthReadWaitsBehindNoOnesRequests(t *testing.T) {
	api := &identityAPI{}
	s, _ := identityServiceWith(t, api, ServiceOptions{ClientQPS: 1, ClientBurst: 1})
	crowd, leave := context.WithCancel(auth.WithPayload(cluster.WithID(context.Background(), idc), auth.TokenPayload{UserID: "u1", Email: "reader@example.com"}))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, _ = s.RawRequest(crowd, "GET", "/api/v1/namespaces")
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(api.seenNow()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond) // the first of the crowd has gone; the others wait their turn
	}
	start := time.Now()
	err := s.HealthCheck(context.Background())
	took := time.Since(start)
	leave()
	wg.Wait()
	if err != nil || took > healthReadBudget {
		t.Errorf("with the people's requests queued: %v after %v, want an answer within %v", err, took.Round(time.Millisecond), healthReadBudget)
	}
}

// The read's budget starts once the default cluster's bundle is found: a default slow to name (1 s) and an API server
// slow to answer (0.8 s) make no failure of a read whose own part is within it.
func TestHealthReadBudgetStartsOnceTheClusterIsFound(t *testing.T) {
	api := &identityAPI{}
	s, reg := identityServiceWith(t, api, ServiceOptions{})
	s.Invalidate(idc) // the next read finds the default cluster again
	reg.defaultTakes.Store(int64(time.Second))
	api.slowVersion(800 * time.Millisecond)
	if err := s.HealthCheck(context.Background()); err != nil {
		t.Errorf("a default slow to name and a slow /version: %v", err)
	}
}

// A dropped default cluster (Invalidate, another replica's notice, a changed config version) forgets the health answer
// kept for it: the next call reads the cluster again.
func TestDroppingTheDefaultClusterForgetsTheHealthAnswer(t *testing.T) {
	api := &identityAPI{}
	s := identityService(t, api)
	for name, drop := range map[string]func(){
		"Invalidate":  func() { s.Invalidate(idc) },
		"DropCluster": func() { s.DropCluster(idc) },
		"DropStale":   func() { s.DropStale(idc, s.ClusterVersions()[idc]) },
	} {
		api.answerVersion("", 0)
		s.forgetHealthRead()
		if err := s.HealthCheck(context.Background()); err != nil {
			t.Fatalf("%s: first read: %v", name, err)
		}
		api.take()
		api.answerVersion("", http.StatusServiceUnavailable) // the cluster now refuses
		drop()
		if err := s.HealthCheck(context.Background()); err == nil {
			t.Errorf("%s: the answer kept from before the drop came back", name)
		}
		if n := versionAsks(api.take()); n != 1 {
			t.Errorf("%s: asked %d times after the drop, want once", name, n)
		}
	}
}

// A read that panics is a failure its callers get and the log names, not a process that ends.
func TestAHealthReadThatPanicsIsAFailure(t *testing.T) {
	logs := captureLogs(t)
	api := &identityAPI{}
	s, reg := identityServiceWith(t, api, ServiceOptions{})
	s.Invalidate(idc)
	reg.panics.Store(true)
	err := s.HealthCheck(context.Background())
	if err == nil || !strings.Contains(err.Error(), "panicked") {
		t.Errorf("a read that panicked: %v, want a failure", err)
	}
	if again := s.HealthCheck(context.Background()); again == nil || again.Error() != err.Error() {
		t.Errorf("within healthReadEvery: %v, want the same failure", again)
	}
	if !strings.Contains(logs.take(), "health read panicked") {
		t.Error("the panic was not logged")
	}
}

func toString(v interface{}) string {
	s, _ := v.(string)
	return s
}
