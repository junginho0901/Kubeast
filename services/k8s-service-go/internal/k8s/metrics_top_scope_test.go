package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// metricsAPI stands in for an API server and its metrics.k8s.io: each namespace's pods as given, or the status a
// namespace answers instead, or, while not served, the API server's plain 404 for a path no API group serves. It counts
// the metrics lists asked and the most under way at once. With discovery it also serves API discovery, listing
// metrics.k8s.io while served, and the client reads it.
type metricsAPI struct {
	notServed atomic.Bool
	refused   bool                // every list answers 403 with a Status, as kube-apiserver refuses an identity
	pods      map[string][]string // namespace → its items as JSON
	status    map[string]int      // namespace → the status it answers instead of its list
	broken    map[string]bool     // namespace → a 200 whose body is not JSON
	delay     time.Duration       // how long a list that answers its items takes
	discovery bool
	// refusedUser: the caller whose lists answer 403, before the path is looked at, as the API server authorizes a
	// request before it finds what serves the path
	refusedUser string
	// down: metrics-server registered and not answering: discovery names metrics.k8s.io/v1beta1 and its resources answer
	// 503, as do its lists
	down bool

	mu             sync.Mutex
	asked          []string
	running        int
	most           int
	discoveryReads int // the group list (/apis) asked: once a discovery read, twice when a group does not answer
}

func (a *metricsAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b := &clientBundle{clientset: cs}
	if a.discovery {
		b.discovery = cs.Discovery()
	}
	s := &Service{}
	s.defaultBundle.Store(b)
	return s
}

// serveDiscovery answers API discovery as a legacy (not aggregated) API server: core v1, apps/v1 and, while served,
// metrics.k8s.io/v1beta1.
func (a *metricsAPI) serveDiscovery(w http.ResponseWriter, r *http.Request) bool {
	const metricsGV = `{"groupVersion":"metrics.k8s.io/v1beta1","version":"v1beta1"}`
	switch r.URL.Path {
	case "/api":
		_, _ = w.Write([]byte(`{"kind":"APIVersions","versions":["v1"]}`))
	case "/api/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["get","list"]},{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list"]}]}`))
	case "/apis":
		a.mu.Lock()
		a.discoveryReads++
		a.mu.Unlock()
		groups := []string{`{"name":"apps","versions":[{"groupVersion":"apps/v1","version":"v1"}],"preferredVersion":{"groupVersion":"apps/v1","version":"v1"}}`}
		if !a.notServed.Load() {
			groups = append(groups, `{"name":"metrics.k8s.io","versions":[`+metricsGV+`],"preferredVersion":`+metricsGV+`}`)
		}
		_, _ = fmt.Fprintf(w, `{"kind":"APIGroupList","apiVersion":"v1","groups":[%s]}`, strings.Join(groups, ","))
	case "/apis/apps/v1":
		_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"apps/v1","resources":[{"name":"deployments","singularName":"deployment","namespaced":true,"kind":"Deployment","verbs":["get","list"]}]}`))
	case "/apis/metrics.k8s.io/v1beta1":
		switch {
		case a.notServed.Load():
			http.NotFound(w, r)
		case a.down:
			unavailable(w)
		default:
			_, _ = w.Write([]byte(`{"kind":"APIResourceList","groupVersion":"metrics.k8s.io/v1beta1","resources":[{"name":"nodes","namespaced":false,"kind":"NodeMetrics","verbs":["get","list"]},{"name":"pods","namespaced":true,"kind":"PodMetrics","verbs":["get","list"]}]}`))
		}
	default:
		return false
	}
	return true
}

// unavailable is the aggregator's answer for an APIService whose server does not answer.
func unavailable(w http.ResponseWriter) {
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"the server is currently unable to handle the request","reason":"ServiceUnavailable","code":503}`))
}

func (a *metricsAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/v1/nodes" {
		_, _ = w.Write([]byte(`{"items":[]}`))
		return
	}
	if a.discovery && a.serveDiscovery(w, r) {
		return
	}
	const prefix = "/apis/metrics.k8s.io/v1beta1/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	a.mu.Lock()
	a.asked = append(a.asked, r.URL.Path)
	a.running++
	a.most = max(a.most, a.running)
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.running--
		a.mu.Unlock()
	}()
	sub := strings.TrimPrefix(r.URL.Path, prefix)
	refused := a.refused || (a.refusedUser != "" && r.Header.Get(auth.HeaderImpersonateUser) == a.refusedUser)
	if !refused && a.notServed.Load() {
		http.NotFound(w, r) // what kube-apiserver's notfoundhandler writes
		return
	}
	if !refused && a.down {
		unavailable(w)
		return
	}
	if refused {
		resource, where := "nodes", "at the cluster scope"
		if strings.HasSuffix(sub, "pods") {
			resource, where = "pods", "at the cluster scope"
			if ns, ok := strings.CutPrefix(strings.TrimSuffix(sub, "/pods"), "namespaces/"); ok {
				where = fmt.Sprintf(`in the namespace \"%s\"`, ns)
			}
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":"%[1]s.metrics.k8s.io is forbidden: User \"u1\" cannot list resource \"%[1]s\" in API group \"metrics.k8s.io\" %[2]s","reason":"Forbidden","details":{"group":"metrics.k8s.io","kind":"%[1]s"},"code":403}`, resource, where)
		return
	}
	switch {
	case sub == "nodes":
		_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"n1"},"usage":{"cpu":"250m","memory":"512Mi"},"timestamp":"t","window":"30s"}]}`))
	case sub == "pods":
		var all []string
		for _, items := range a.pods {
			all = append(all, items...)
		}
		_, _ = fmt.Fprintf(w, `{"items":[%s]}`, strings.Join(all, ","))
	case strings.HasPrefix(sub, "namespaces/") && strings.HasSuffix(sub, "/pods"):
		ns := strings.TrimSuffix(strings.TrimPrefix(sub, "namespaces/"), "/pods")
		if code := a.status[ns]; code != 0 {
			// plain text, so each namespace's refusal or failure reads differently through RawRequest
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(code)
			_, _ = fmt.Fprintf(w, "%d for namespace %s", code, ns)
			return
		}
		time.Sleep(a.delay)
		if a.broken[ns] {
			_, _ = w.Write([]byte(`not json`))
			return
		}
		_, _ = fmt.Fprintf(w, `{"items":[%s]}`, strings.Join(a.pods[ns], ","))
	default:
		http.NotFound(w, r)
	}
}

func (a *metricsAPI) counts() (asked, most int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.asked), a.most
}

func (a *metricsAPI) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.asked, a.most = nil, 0
}

// limitedTo is a caller whose grant on the default cluster is limited to namespaces.
func limitedTo(namespaces []string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": namespaces}})
}

func loadNamespaces(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("load-ns-%02d", i)
	}
	return out
}

// randomPods gives each namespace up to five pods with CPU drawn from a few values, so the ranking meets ties.
func randomPods(r *rand.Rand, namespaces []string) map[string][]string {
	cpus := []string{"0", "1m", "5m", "5m", "250m", "1500000n", "2"}
	out := map[string][]string{}
	for _, ns := range namespaces {
		for p := range r.IntN(6) {
			out[ns] = append(out[ns], fmt.Sprintf(`{"metadata":{"name":"pod-%d","namespace":"%s"},"containers":[{"name":"c","usage":{"cpu":"%s","memory":"%dMi"}}],"timestamp":"t","window":"30s"}`,
				p, ns, cpus[r.IntN(len(cpus))], r.IntN(512)))
		}
	}
	return out
}

// oneAfterAnother is top-resources' read of a limited grant's pod metrics as it was, each namespace in turn.
func oneAfterAnother(ctx context.Context, s *Service) ([]podMetricsItem, error) {
	var podItems []podMetricsItem
	err := eachCallerNamespace(ctx, "", func(ns string) error {
		podBody, _, err := s.RawRequest(ctx, "GET", podMetricsPath(ns))
		if err != nil {
			return err
		}
		var podResp podMetricsResponse
		if json.Unmarshal(podBody, &podResp) == nil {
			podItems = append(podItems, podResp.Items...)
		}
		return nil
	})
	return podItems, err
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// A grant limited to namespaces gets from the reads side by side the rows, in their order, and the error that asking
// the namespaces one after another gives, and the cluster is asked no namespace more: each once while none fails, and
// no namespace after a failure but those already under way.
func TestTopPodsOfALimitedGrantAreWhatOneRequestAfterAnotherGives(t *testing.T) {
	r := rand.New(rand.NewPCG(11, 15))
	scope := loadNamespaces(20)
	cases := []struct {
		name   string
		status map[string]int
		broken map[string]bool
		failed bool // a namespace's failure ends the turn
	}{
		{name: "every namespace answers", broken: map[string]bool{scope[6]: true}},
		{name: "some refused", status: map[string]int{scope[0]: 403, scope[4]: 403, scope[13]: 403, scope[19]: 403}},
		{name: "every namespace refused", status: func() map[string]int {
			out := map[string]int{}
			for _, ns := range scope {
				out[ns] = 403
			}
			return out
		}()},
		{name: "a failure after a refusal", status: map[string]int{scope[1]: 403, scope[3]: 500, scope[12]: 500}, failed: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := &metricsAPI{pods: randomPods(r, scope), status: c.status, broken: c.broken, delay: 50 * time.Millisecond}
			s := api.service(t)
			ctx := limitedTo(scope)
			want, wantErr := oneAfterAnother(ctx, s)
			before, _ := api.counts()
			api.reset()
			got, gotErr := s.topPodItems(ctx)
			after, _ := api.counts()
			if !reflect.DeepEqual(got, want) || errText(gotErr) != errText(wantErr) {
				t.Fatalf("side by side: %d rows, error %q; one after another: %d rows, error %q", len(got), errText(gotErr), len(want), errText(wantErr))
			}
			if c.failed {
				if after > before+listFanOutWorkers-1 {
					t.Errorf("asked %d namespaces, one after another %d: more than those already under way", after, before)
				}
				return
			}
			if after != before {
				t.Errorf("asked %d lists, one after another %d", after, before)
			}
		})
	}
	// every namespace refused: the error is the last namespace's, as in turn
	api := &metricsAPI{status: map[string]int{}}
	for _, ns := range scope {
		api.status[ns] = 403
	}
	if _, err := api.service(t).topPodItems(limitedTo(scope)); !strings.HasSuffix(errText(err), " "+scope[19]) {
		t.Errorf("refused everywhere: %v", err)
	}
}

// The namespaces of a limited grant are asked side by side, never more than listFanOutWorkers at once, each once.
func TestTopPodsOfALimitedGrantAskAtMostEightNamespacesAtOnce(t *testing.T) {
	scope := loadNamespaces(20)
	api := &metricsAPI{pods: randomPods(rand.New(rand.NewPCG(3, 4)), scope), delay: 30 * time.Millisecond}
	s := api.service(t)
	if _, err := s.topPodItems(limitedTo(scope)); err != nil {
		t.Fatal(err)
	}
	asked, most := api.counts()
	if asked != len(scope) {
		t.Errorf("asked %d lists for %d namespaces", asked, len(scope))
	}
	if most < 2 || most > listFanOutWorkers {
		t.Errorf("%d lists under way at once, want 2 to %d", most, listFanOutWorkers)
	}
}

// A refusal reads as the cluster wrote it, with refused set, where RawRequest left "unknown"; it is not remembered, and a
// part the screen keeps from its refusal (skip) is not asked.
func TestTopResourcesSayARefusalAsTheClusterWroteIt(t *testing.T) {
	scope := loadNamespaces(2)
	api := &metricsAPI{refused: true}
	s := api.service(t)
	got, err := s.GetTopResources(limitedTo(scope), 5, 3, TopSkip{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{
		"top_pods":             []map[string]interface{}{},
		"pod_metrics_error":    `pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "load-ns-01"`,
		"pod_metrics_refused":  true,
		"top_nodes":            []map[string]interface{}{},
		"node_metrics_error":   `nodes.metrics.k8s.io is forbidden: User "u1" cannot list resource "nodes" in API group "metrics.k8s.io" at the cluster scope`,
		"node_metrics_refused": true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("refused answer:\n%v\nwant\n%v", got, want)
	}
	if asked, _ := api.counts(); asked != 3 {
		t.Fatalf("asked %d lists, want the two namespaces' and the nodes'", asked)
	}
	_, _ = s.GetTopResources(limitedTo(scope), 5, 3, TopSkip{})
	if asked, _ := api.counts(); asked != 6 {
		t.Errorf("a refusal was remembered: %d lists after two requests", asked)
	}
	api.reset()
	if got, _ := s.GetTopResources(limitedTo(scope), 5, 3, TopSkip{Pods: true, Nodes: true}); len(got) != 0 {
		t.Errorf("both parts left out: %v", got)
	}
	nodesKept, _ := s.GetTopResources(limitedTo(scope), 5, 3, TopSkip{Nodes: true})
	if asked, _ := api.counts(); asked != 2 || nodesKept["top_nodes"] != nil || nodesKept["pod_metrics_refused"] != true {
		t.Errorf("nodes left out: asked %d lists, answer %v", asked, nodesKept)
	}
}
