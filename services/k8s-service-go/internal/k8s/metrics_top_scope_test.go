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
// the metrics lists asked and the most under way at once.
type metricsAPI struct {
	notServed atomic.Bool
	refused   bool                // every list answers 403 with a Status, as kube-apiserver refuses an identity
	pods      map[string][]string // namespace → its items as JSON
	status    map[string]int      // namespace → the status it answers instead of its list
	broken    map[string]bool     // namespace → a 200 whose body is not JSON
	delay     time.Duration       // how long a list that answers its items takes

	mu      sync.Mutex
	asked   []string
	running int
	most    int
}

func (a *metricsAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

func (a *metricsAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/v1/nodes" {
		_, _ = w.Write([]byte(`{"items":[]}`))
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
	if a.notServed.Load() {
		http.NotFound(w, r) // what kube-apiserver's notfoundhandler writes
		return
	}
	sub := strings.TrimPrefix(r.URL.Path, prefix)
	if a.refused {
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

// A cluster that does not serve metrics.k8s.io is asked once: every caller of the cluster gets its answer for
// metricsMissTTL, the same answer the cluster gives, then one caller asks again, and a metrics-server installed since
// answers from that ask on.
func TestAClusterWithoutTheMetricsAPIIsAskedOnceWithinTheMinute(t *testing.T) {
	const notFound = "the server could not find the requested resource"
	scope := loadNamespaces(20)
	// the pods a metrics-server installed later answers
	api := &metricsAPI{pods: map[string][]string{"default": {`{"metadata":{"name":"web","namespace":"default"},"containers":[{"name":"c","usage":{"cpu":"5m","memory":"10Mi"}}],"timestamp":"t"}`}}}
	api.notServed.Store(true)
	s := api.service(t)
	wide := context.Background()

	first, err := s.GetTopResources(wide, 5, 3, TopSkip{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{"top_pods": []map[string]interface{}{}, "top_nodes": []map[string]interface{}{}, "pod_metrics_error": notFound, "node_metrics_error": notFound}
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("first answer: %v", first)
	}
	if asked, _ := api.counts(); asked != 1 {
		t.Fatalf("first request asked %d lists, want 1 (the node list after the pods' 404 is not asked)", asked)
	}
	again, _ := s.GetTopResources(wide, 5, 3, TopSkip{})
	limited, _ := s.GetTopResources(limitedTo(scope), 5, 3, TopSkip{})
	if asked, _ := api.counts(); asked != 1 {
		t.Fatalf("asked %d lists within the minute, want 1", asked)
	}
	if !reflect.DeepEqual(again, first) {
		t.Errorf("second answer %v, first %v", again, first)
	}
	// the limited grant's answer is the one the cluster gives it when asked
	fresh := &metricsAPI{}
	fresh.notServed.Store(true)
	if asked, _ := fresh.service(t).GetTopResources(limitedTo(scope), 5, 3, TopSkip{}); !reflect.DeepEqual(limited, asked) {
		t.Errorf("limited grant from the cluster's answer %v, asking %v", limited, asked)
	}

	b := s.defaultBundle.Load()
	expire := func() {
		m := b.metricsMissing.Load()
		if m == nil {
			t.Fatal("nothing remembered")
		}
		b.metricsMissing.Store(&metricsMiss{err: m.err, until: time.Now().Add(-time.Millisecond)})
	}
	// past the minute, a crowd asks once
	expire()
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, _ := s.GetTopResources(wide, 5, 3, TopSkip{})
			if !reflect.DeepEqual(got, first) {
				t.Errorf("answer past the minute: %v", got)
			}
		}()
	}
	wg.Wait()
	if asked, _ := api.counts(); asked != 2 {
		t.Fatalf("20 callers past the minute asked %d lists in all, want 2", asked)
	}

	// metrics-server installed: the next ask past the minute is answered, and every request asks from then on
	api.notServed.Store(false)
	expire()
	served, _ := s.GetTopResources(wide, 5, 3, TopSkip{})
	if pods, _ := served["top_pods"].([]map[string]interface{}); len(pods) != 1 || served["pod_metrics_error"] != nil || served["node_metrics_error"] != nil {
		t.Fatalf("answer once served: %v", served)
	}
	if b.metricsMissing.Load() != nil {
		t.Error("still remembered as not served")
	}
	api.reset()
	_, _ = s.GetTopResources(wide, 5, 3, TopSkip{})
	if asked, _ := api.counts(); asked != 2 {
		t.Errorf("a served cluster asked %d lists, want the pods' and the nodes'", asked)
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
