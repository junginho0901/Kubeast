package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type apiCluster struct{ url string }

func (apiCluster) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (apiCluster) Default(context.Context) (cluster.ID, error)  { return "alpha", nil }
func (c apiCluster) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: {server: %q}
users:
- name: u
  user: {}
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
`, c.url)}, nil
}

// describeAPI answers a Deployment's describe reads as the API server does, naming in the object whom it answered, so
// an answer that reached another identity shows.
type describeAPI struct {
	delay     time.Duration
	gate      chan struct{} // when set, a Deployment read waits for it
	missing   bool
	gets      atomic.Int64
	getsNamed sync.Map // "<user>/<deployment>" → *atomic.Int64
}

func (a *describeAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	user := r.Header.Get(auth.HeaderImpersonateUser)
	switch {
	case strings.Contains(r.URL.Path, "/events"):
		_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}})
	case strings.Contains(r.URL.Path, "/deployments/"):
		a.gets.Add(1)
		name := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		v, _ := a.getsNamed.LoadOrStore(user+"/"+name, &atomic.Int64{})
		v.(*atomic.Int64).Add(1)
		if a.gate != nil && name == "web" {
			select {
			case <-a.gate:
			case <-r.Context().Done():
				return
			}
		}
		time.Sleep(a.delay)
		if a.missing {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404,"message":"deployments.apps \"` + name + `\" not found"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(appsv1.Deployment{
			TypeMeta:   metav1.TypeMeta{Kind: "Deployment", APIVersion: "apps/v1"},
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "demo", UID: "u-1", Annotations: map[string]string{"answered-for": user}},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (a *describeAPI) getsOf(user, name string) int64 {
	v, ok := a.getsNamed.Load(user + "/" + name)
	if !ok {
		return 0
	}
	return v.(*atomic.Int64).Load()
}

// describeRouter is the routes behind the middleware that sign the caller in and name the cluster, on a real router: a
// router reuses its route context once a request has ended.
func describeRouter(t *testing.T, api *describeAPI) http.Handler {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	svc, err := k8s.NewService(context.Background(), apiCluster{url: srv.URL}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Config{}, nil)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			user := req.Header.Get("X-Test-User")
			perms := auth.PermissionMatrix{"alpha": {"resource.*.read"}}
			next.ServeHTTP(w, req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: user, Email: user, Perms: perms, Roles: map[string]string{"alpha": "read"}})))
		})
	})
	r.Use(h.ClusterMiddleware)
	RegisterWorkloads(sharingReads(r, h), h)
	return r
}

// A new describe says here whether one run may answer everyone: one that reveals or audits per caller may not.
func TestEveryDescribeRouteSaysWhetherItIsShared(t *testing.T) {
	r := screenRouter(t)
	n := 0
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodGet || !strings.HasSuffix(route, "/describe") {
			return nil
		}
		n++
		if sharedReadRoutes[route] == notSharedDescribes[route] {
			t.Errorf("%s: shared %v, not shared %v, want one of them", route, sharedReadRoutes[route], notSharedDescribes[route])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n < 50 {
		t.Errorf("walked %d describe routes", n)
	}
}

// Every entry of the list is a route, so a route renamed does not quietly stop being shared.
func TestEverySharedRouteExists(t *testing.T) {
	seen := map[string]bool{}
	err := chi.Walk(fullRouter(t), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodGet {
			seen[route] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for route := range sharedReadRoutes {
		if !seen[route] {
			t.Errorf("%s is no GET route", route)
		}
	}
}

func fullRouter(t *testing.T) chi.Router {
	t.Helper()
	svc, err := k8s.NewService(context.Background(), unreachableCluster{}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	Register(r, handler.New(svc, config.Config{}, nil), ws.NewMultiplexer(svc))
	return r
}

type answer struct {
	status int
	body   string
	trail  string
}

func ask(t *testing.T, srv *httptest.Server, ctx context.Context, user, path string, record bool) (answer, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+path, nil)
	if err != nil {
		return answer{}, err
	}
	req.Header.Set("X-Test-User", user)
	if record {
		req.Header.Set(accesstrail.HeaderRecord, "1")
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		return answer{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return answer{}, err
	}
	return answer{res.StatusCode, string(b), res.Header.Get(accesstrail.HeaderRequests)}, nil
}

const webDescribe = "/api/v1/namespaces/demo/deployments/web/describe"

// Thirty people's worth of one person's reads at one moment are about one read of the object, and every answer is the
// answer a lone request gets.
func TestDescribesOfOneCallerAtOnceReadTheObjectAtMostTwice(t *testing.T) {
	api := &describeAPI{delay: 30 * time.Millisecond}
	srv := httptest.NewServer(describeRouter(t, api))
	defer srv.Close()
	lone, err := ask(t, srv, context.Background(), "alice", webDescribe, false)
	if err != nil || lone.status != http.StatusOK {
		t.Fatalf("lone read: %+v %v", lone, err)
	}
	api.gets.Store(0)

	var wg sync.WaitGroup
	answers := make([]answer, 30)
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], _ = ask(t, srv, context.Background(), "alice", webDescribe, false)
		}()
	}
	wg.Wait()
	t.Logf("object reads for 30 requests at once: %d", api.gets.Load())
	if got := api.gets.Load(); got > 2 {
		t.Errorf("%d reads of the object for 30 requests of one caller, want at most 2", got)
	}
	for i, a := range answers {
		if a.status != http.StatusOK || a.body != lone.body {
			t.Fatalf("answer %d differs from a lone read: %d %s", i, a.status, a.body)
		}
	}
}

// An answer never reaches another identity, nor another object.
func TestDescribesAreNotSharedBetweenIdentitiesOrObjects(t *testing.T) {
	api := &describeAPI{delay: 20 * time.Millisecond}
	srv := httptest.NewServer(describeRouter(t, api))
	defer srv.Close()
	var wg sync.WaitGroup
	for _, user := range []string{"alice", "bob"} {
		for _, name := range []string{"web", "api"} {
			for i := 0; i < 10; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					a, err := ask(t, srv, context.Background(), user, "/api/v1/namespaces/demo/deployments/"+name+"/describe", false)
					if err != nil || a.status != http.StatusOK {
						t.Errorf("%s/%s: %+v %v", user, name, a, err)
						return
					}
					var got map[string]any
					if err := json.Unmarshal([]byte(a.body), &got); err != nil {
						t.Error(err)
						return
					}
					annotations, _ := got["annotations"].(map[string]any)
					if annotations["answered-for"] != user || got["name"] != name {
						t.Errorf("%s asked about %s and got %v of %v", user, name, annotations["answered-for"], got["name"])
					}
				}()
			}
		}
	}
	wg.Wait()
	for _, user := range []string{"alice", "bob"} {
		for _, name := range []string{"web", "api"} {
			got := api.getsOf(user, name)
			t.Logf("reads of %s as %s: %d", name, user, got)
			if got > 2 {
				t.Errorf("%s as %s read %d times for 10 requests", name, user, got)
			}
		}
	}
}

// The request a read started for may go away: those waiting get the answer, of the object they asked about, whatever
// the router does with the first request's route once it has ended.
func TestADescribeOutlivesTheRequestItStartedFor(t *testing.T) {
	api := &describeAPI{gate: make(chan struct{})}
	srv := httptest.NewServer(describeRouter(t, api))
	defer srv.Close()

	// A read under way, so the next read waits with the request it was made for and one that joined it.
	firstAnswer := make(chan answer, 1)
	go func() {
		a, _ := ask(t, srv, context.Background(), "alice", webDescribe, false)
		firstAnswer <- a
	}()
	deadline := time.Now().Add(5 * time.Second)
	for api.gets.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the first read did not start")
		}
		time.Sleep(time.Millisecond)
	}
	gone, leave := context.WithCancel(context.Background())
	defer leave()
	goneDone := make(chan struct{})
	go func() {
		defer close(goneDone)
		_, _ = ask(t, srv, gone, "alice", webDescribe, false)
	}()
	time.Sleep(50 * time.Millisecond)
	stayed := make(chan answer, 1)
	go func() {
		a, _ := ask(t, srv, context.Background(), "alice", webDescribe, false)
		stayed <- a
	}()
	time.Sleep(50 * time.Millisecond)
	leave()
	<-goneDone
	time.Sleep(50 * time.Millisecond)
	// other requests take the route context the request that left gave back
	for i := 0; i < 50; i++ {
		other, err := ask(t, srv, context.Background(), "alice", "/api/v1/namespaces/demo/deployments/other/describe", false)
		if err != nil || !strings.Contains(other.body, `"name":"other"`) {
			t.Fatalf("other read: %+v %v", other, err)
		}
	}
	close(api.gate)
	for name, c := range map[string]chan answer{"the first request": firstAnswer, "the request that stayed": stayed} {
		a := <-c
		if a.status != http.StatusOK || !strings.Contains(a.body, `"name":"web"`) {
			t.Errorf("%s got %d %s", name, a.status, a.body)
		}
	}
}

// A request with no read to wait for writes its answer as it comes, holding no copy of it: a list of a whole namespace
// is about as large as what is left of the memory limit.
func TestALoneReadHoldsNoCopyOfItsAnswer(t *testing.T) {
	const size = 8 << 20
	body := []byte(strings.Repeat("x", size))
	svc, err := k8s.NewService(context.Background(), unreachableCluster{}, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	shared := handler.New(svc, config.Config{}, nil).Shared(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	})
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "alice"}))
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	w := &countingWriter{header: http.Header{}}
	shared(w, r)
	runtime.ReadMemStats(&after)
	if w.written != size {
		t.Fatalf("%d bytes written", w.written)
	}
	if extra := after.TotalAlloc - before.TotalAlloc; extra > size/2 {
		t.Errorf("a lone read of %d bytes allocated %d more", size, extra)
	}
}

type countingWriter struct {
	header  http.Header
	written int
}

func (c *countingWriter) Header() http.Header { return c.header }
func (c *countingWriter) WriteHeader(int)     {}
func (c *countingWriter) Write(b []byte) (int, error) {
	c.written += len(b)
	return len(b), nil
}

// A failed read answers everyone waiting on it as it would have answered alone.
func TestAFailedDescribeAnswersEveryoneAsItWouldAlone(t *testing.T) {
	api := &describeAPI{delay: 20 * time.Millisecond, missing: true}
	srv := httptest.NewServer(describeRouter(t, api))
	defer srv.Close()
	lone, err := ask(t, srv, context.Background(), "alice", webDescribe, false)
	if err != nil || lone.status != http.StatusNotFound {
		t.Fatalf("lone read: %+v %v", lone, err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := ask(t, srv, context.Background(), "alice", webDescribe, false)
			if err != nil || a.status != lone.status || a.body != lone.body {
				t.Errorf("answer %d: %+v %v, alone %+v", i, a, err, lone)
			}
		}()
	}
	wg.Wait()
}

// An AI tool call's list of cluster requests says what it did: the read it made, or that another's read answered it.
func TestARecordedCallSaysWhetherItsReadWasItsOwn(t *testing.T) {
	api := &describeAPI{delay: 30 * time.Millisecond}
	srv := httptest.NewServer(describeRouter(t, api))
	defer srv.Close()
	var wg sync.WaitGroup
	var mu sync.Mutex
	own, shared := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := ask(t, srv, context.Background(), "alice", webDescribe, true)
			if err != nil || a.status != http.StatusOK {
				t.Errorf("answer: %+v %v", a, err)
				return
			}
			trail, ok := accesstrail.ParseHeader(a.trail)
			if !ok || len(trail.Requests) == 0 {
				t.Errorf("no requests listed: %q", a.trail)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			if trail.Requests[0].Source == "cache" {
				shared++
			} else {
				own++
			}
		}()
	}
	wg.Wait()
	t.Logf("calls that read for themselves %d, calls another's read answered %d", own, shared)
	if own+shared != 8 || own > 2 {
		t.Errorf("own %d, shared %d of 8 calls", own, shared)
	}
}
