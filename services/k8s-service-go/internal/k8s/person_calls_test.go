package k8s

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
	mu   sync.Mutex
	seen []identitySeen
}

func (a *identityAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.seen = append(a.seen, identitySeen{r.Method, r.URL.Path, r.Header.Get(auth.HeaderImpersonateUser)})
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	p := r.URL.Path
	switch {
	case p == "/version":
		_, _ = w.Write([]byte(`{"major":"1","minor":"35","gitVersion":"v1.35.0"}`))
	case p == "/api":
		_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[{"clientCIDR":"0.0.0.0/0","serverAddress":"127.0.0.1"}]}`))
	case p == "/apis":
		_, _ = w.Write([]byte(`{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}],"preferredVersion":{"groupVersion":"apps/v1","version":"v1"}}]}`))
	case p == "/api/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]},{"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["get","list","watch"]}]}`))
	case p == "/apis/apps/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"apps/v1","resources":[{"name":"deployments","singularName":"deployment","namespaced":true,"kind":"Deployment","verbs":["get","list","watch"]}]}`))
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

// Every request a person's screen makes reaches the cluster as that person, but the reads Kubeast keeps once for
// everyone (the version, the cluster's discovery lists, the served versions of a kind) and its health reads, which go
// as Kubeast itself; a request whose context names no one is not sent.
func TestEveryUserCallCarriesThePerson(t *testing.T) {
	api := &identityAPI{}
	srv := httptest.NewServer(api)
	defer srv.Close()
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": {ID: "a", Mode: cluster.ModeExternal, KubeconfigBlob: kc}}}
	wasOff := informersOff
	s, err := NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), ServiceOptions{MaxClusters: 20, Impersonation: true, NoInformers: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { impersonationEnabled, informersOff = false, wasOff })

	const person = "reader@example.com"
	callerCtx := auth.WithPayload(cluster.WithID(context.Background(), "a"), auth.TokenPayload{UserID: "u1", Email: person, Roles: map[string]string{"a": "Read"}})
	pinned, err := s.UserRESTConfigFor(callerCtx)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		name string
		run  func(ctx context.Context) error
		own  bool // Kubeast's own reads: no person goes with them
	}{
		{name: "overview", run: func(ctx context.Context) error { _, err := s.GetClusterOverview(ctx); return err }},
		{name: "api-resources", own: true, run: func(ctx context.Context) error { _, err := s.GetAPIResources(ctx); return err }},
		{name: "cluster-config", run: func(ctx context.Context) error { _, err := s.GetClusterConfig(ctx); return err }},
		{name: "ResolveGVR", own: true, run: func(ctx context.Context) error {
			if _, ok := s.ResolveGVR(ctx, "apps", "deployments"); !ok {
				return errors.New("apps/deployments not resolved")
			}
			return nil
		}},
		{name: "hygiene", run: func(ctx context.Context) error { _, err := s.CollectHygiene(ctx, HygieneOptions{}); return err }},
		{name: "watch", run: func(ctx context.Context) error {
			w, err := s.DynamicForCtx(ctx).Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).Namespace("shop").Watch(ctx, metav1.ListOptions{})
			if err == nil {
				w.Stop()
			}
			return err
		}},
		{name: "server version", own: true, run: func(ctx context.Context) error {
			if !s.ServerSupportsResize(ctx) {
				return errors.New("a 1.35 server was said not to resize")
			}
			return nil
		}},
		{name: "a pinned config's request with its own context", run: func(context.Context) error {
			cs, err := kubernetes.NewForConfig(pinned)
			if err != nil {
				return err
			}
			_, err = cs.CoreV1().ConfigMaps("shop").List(context.Background(), metav1.ListOptions{})
			return err
		}},
		{name: "/health", own: true, run: func(context.Context) error { return s.HealthCheck(context.Background()) }},
	} {
		if err := step.run(callerCtx); err != nil {
			t.Errorf("%s: %v", step.name, err)
		}
		seen := api.take()
		if len(seen) == 0 {
			t.Errorf("%s asked the cluster nothing", step.name)
		}
		want := person
		if step.own {
			want = ""
		}
		for _, r := range seen {
			if r.user != want {
				t.Errorf("%s: %s %s went as %q, want %q", step.name, r.method, r.path, r.user, want)
			}
		}
	}

	bare := cluster.WithID(context.Background(), "a")
	if _, _, err := s.RawRequest(bare, "GET", "/version"); !errors.Is(err, auth.ErrNoPerson) {
		t.Errorf("a request naming no one: err %v, want ErrNoPerson", err)
	}
	if _, err := s.GetClusterConfig(bare); err != nil {
		t.Errorf("cluster-config naming no one: %v", err)
	}
	if seen := api.take(); len(seen) != 0 {
		t.Errorf("requests naming no one reached the cluster: %+v", seen)
	}
}
