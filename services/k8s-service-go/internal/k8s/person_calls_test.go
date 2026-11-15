package k8s

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type identitySeen struct{ method, path, user string }

// identityAPI answers as an API server enough for the overview, discovery, the cluster config, hygiene and a watch,
// and keeps whom each request came as.
type identityAPI struct {
	mu           sync.Mutex
	seen         []identitySeen
	versionDelay time.Duration
}

func (a *identityAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.seen = append(a.seen, identitySeen{r.Method, r.URL.Path, r.Header.Get(auth.HeaderImpersonateUser)})
	delay := a.versionDelay
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	switch {
	case p == "/version":
		time.Sleep(delay)
		_, _ = w.Write([]byte(`{"major":"1","minor":"35","gitVersion":"v1.35.0"}`))
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

func (a *identityAPI) slowVersion(d time.Duration) {
	a.mu.Lock()
	a.versionDelay = d
	a.mu.Unlock()
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

const refusedLine = "cluster request with no person refused"

// identityService is a Service on api with impersonation on and no overview informers, and the cluster "a" it reads.
func identityService(t *testing.T, api *identityAPI) *Service {
	t.Helper()
	srv := httptest.NewServer(api)
	t.Cleanup(srv.Close)
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": {ID: "a", Mode: cluster.ModeExternal, KubeconfigBlob: kc}}}
	wasOff := informersOff
	s, err := NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), ServiceOptions{MaxClusters: 20, Impersonation: true, NoInformers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { impersonationEnabled, informersOff = false, wasOff })
	return s
}

// Every request a person's screen makes reaches the cluster as that person, but the reads Kubeast keeps once for
// everyone (the version, the cluster's discovery lists, the served versions of a kind) and its health reads, which go
// as Kubeast itself; a request whose context names no one is not sent, and says so in the log.
func TestEveryUserCallCarriesThePerson(t *testing.T) {
	logs := captureLogs(t)
	api := &identityAPI{}
	s := identityService(t, api)
	const person = "reader@example.com"
	callerCtx := auth.WithPayload(cluster.WithID(context.Background(), "a"), auth.TokenPayload{UserID: "u1", Email: person, Roles: map[string]string{"a": "Read"}})
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
	rows := &healthRows{metas: []cluster.Meta{{ID: "a"}}, written: map[cluster.ID]string{}}
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
		{name: "/health with no health checker", own: []string{"/version"}, run: func(context.Context) error { return s.HealthCheck(context.Background()) }},
		{name: "health checker probe and sweep", own: []string{"/version"}, run: func(context.Context) error {
			if !hc.probe(context.Background(), "a") {
				return errors.New("the probe failed")
			}
			hc.sweep(context.Background())
			if s.ClusterDown("a") || rows.written["a"] != "healthy" {
				return errors.New("the sweep marked the cluster down: " + rows.written["a"])
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
		if n := strings.Count(logs.take(), refusedLine); n != 0 {
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

	bare := cluster.WithID(context.Background(), "a")
	if _, _, err := s.RawRequest(bare, "GET", "/version"); !errors.Is(err, auth.ErrNoPerson) {
		t.Errorf("a request naming no one: err %v, want ErrNoPerson", err)
	}
	if seen := api.take(); len(seen) != 0 {
		t.Errorf("a request naming no one reached the cluster: %+v", seen)
	}
	if lines := logs.take(); strings.Count(lines, refusedLine) != 1 || !strings.Contains(lines, "path=/version") {
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

// While the health checker runs and has probed the default cluster, /health reads the cluster's breaker: a call asks
// the cluster nothing, a slow cluster does not turn it to down between sweeps, an open breaker does. Before that probe,
// and with no checker, it reads /version within 2 s.
func TestHealthAnswersFromTheCheckerWhileItRuns(t *testing.T) {
	api := &identityAPI{}
	s := identityService(t, api)
	s.checked.Store(true) // a checker whose first sweep has not reached the cluster yet
	if err := s.HealthCheck(context.Background()); err != nil {
		t.Errorf("not probed yet: %v", err)
	}
	if seen := api.take(); len(seen) != 1 || seen[0].path != "/version" || seen[0].user != "" {
		t.Errorf("not probed yet: asked %+v, want one /version as Kubeast itself", seen)
	}
	s.checked.Store(false)
	rows := &healthRows{metas: []cluster.Meta{{ID: "a"}}, written: map[cluster.ID]string{}}
	hc := NewHealthChecker(s, rows, time.Hour)
	ctx, stop := context.WithCancel(context.Background())
	ran := make(chan struct{})
	go func() { hc.Run(ctx); close(ran) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows.mu.Lock()
		swept := rows.written["a"] != ""
		rows.mu.Unlock()
		if swept {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the first sweep did not end")
		}
		time.Sleep(10 * time.Millisecond)
	}
	api.take()

	api.slowVersion(3 * time.Second)
	start := time.Now()
	for i := 0; i < 20; i++ {
		if err := s.HealthCheck(context.Background()); err != nil {
			t.Fatalf("call %d: %v while the last sweep found the cluster up", i, err)
		}
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("20 /health reads took %v while the checker runs", took)
	}
	if seen := api.take(); len(seen) != 0 {
		t.Errorf("/health asked the cluster %d times while the checker runs: %+v", len(seen), seen)
	}
	s.health.setOpen("a", true)
	if err := s.HealthCheck(context.Background()); !errors.Is(err, errClusterDown) {
		t.Errorf("open breaker: %v, want errClusterDown", err)
	}
	s.health.setOpen("a", false)

	stop()
	<-ran
	api.slowVersion(700 * time.Millisecond)
	if err := s.HealthCheck(context.Background()); err != nil {
		t.Errorf("no checker, a cluster answering in 700 ms: %v", err)
	}
	if seen := api.take(); len(seen) != 1 || seen[0].path != "/version" || seen[0].user != "" {
		t.Errorf("no checker: asked %+v, want one /version as Kubeast itself", seen)
	}
}

func toString(v interface{}) string {
	s, _ := v.(string)
	return s
}
