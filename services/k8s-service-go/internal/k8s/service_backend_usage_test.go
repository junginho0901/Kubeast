package k8s

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"
)

// podMatcher is the pod=~ matcher of a query as Prometheus parses it, which anchors its regular expression.
func podMatcher(t *testing.T, query string) *labels.Matcher {
	t.Helper()
	expr, err := parser.NewParser(parser.Options{}).ParseExpr(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	var found *labels.Matcher
	parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
		if vs, ok := node.(*parser.VectorSelector); ok {
			for _, m := range vs.LabelMatchers {
				if m.Name == "pod" {
					found = m
				}
			}
		}
		return nil
	})
	if found == nil || found.Type != labels.MatchRegexp {
		t.Fatalf("%s: no pod=~ matcher", query)
	}
	return found
}

// selectorMatchers are the label matchers of a query's one vector selector as Prometheus parses it.
func selectorMatchers(t *testing.T, query string) []*labels.Matcher {
	t.Helper()
	expr, err := parser.NewParser(parser.Options{}).ParseExpr(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	var selectors [][]*labels.Matcher
	parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
		if vs, ok := node.(*parser.VectorSelector); ok {
			selectors = append(selectors, vs.LabelMatchers)
		}
		return nil
	})
	if len(selectors) != 1 {
		t.Fatalf("%s: %d vector selectors, want 1", query, len(selectors))
	}
	return selectors[0]
}

// writtenPattern is a pattern as the query's PromQL string writes it, without its quotes.
func writtenPattern(p string) string { return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(p) }

// workloadPodNames are the pods of many workloads, past one query, and pods of the namespace that are not among them.
func workloadPodNames() (names, others []string) {
	for i := 0; i < 3000; i++ {
		names = append(names, fmt.Sprintf("web-7d9f8c6b5-%05x", i*7919))
	}
	for i := 0; i < 700; i++ {
		names = append(names, fmt.Sprintf("db-%d", i))
		others = append(others, fmt.Sprintf("db-%d", i+700), fmt.Sprintf("xdb-%d", i))
	}
	names = append(names, "api.v2-0", "api.v2-1", "solo")
	others = append(others, "apixv2-0", "web-7d9f8c6b5-", "web-7d9f8c6b5-zzzzz", "sol", "solo-0", "db-")
	return names, others
}

// A pattern written for names that fit one query is the screen's (serviceBackend.ts podNamesPattern).
func TestBackendPodPatternsWriteWhatTheScreenWrites(t *testing.T) {
	got := backendPodPatterns([]string{"web-7d9f-d3e4f", "db-0", "web-7d9f-a1b2c", "web.v2-0", "db-0"}, backendPatternMax)
	if want := []string{`db-0|web-7d9f-(a1b2c|d3e4f)|web\.v2-0`}; strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("patterns = %q, want %q", got, want)
	}
}

// Past one query the names go into as many patterns as it takes: each under the size one query carries, each name in
// exactly one, and no other pod of the namespace in any, as Prometheus reads the matchers.
func TestBackendPodPatternsNameEachPodOnceAndNoOther(t *testing.T) {
	names, others := workloadPodNames()
	patterns := backendPodPatterns(names, backendPatternMax)
	if len(patterns) < 3 {
		t.Fatalf("%d patterns: the names should not fit fewer", len(patterns))
	}
	matched := map[string]int{}
	for _, p := range patterns {
		if size := len(url.QueryEscape(writtenPattern(p))); size > backendPatternMax {
			t.Errorf("a pattern of %d bytes in a URL, past %d", size, backendPatternMax)
		}
		m := podMatcher(t, backendQueries("shop", p)["cpu"])
		for _, n := range names {
			if m.Matches(n) {
				matched[n]++
			}
		}
		for _, n := range others {
			if m.Matches(n) {
				t.Errorf("%q matches %s, which is not behind the Service", n, p)
			}
		}
	}
	for _, n := range names {
		if matched[n] != 1 {
			t.Errorf("%q is in %d patterns, want 1", n, matched[n])
		}
	}
}

// A namespace and pod names holding a backslash, a quote and a regex metacharacter: Prometheus reads the namespace back
// as given, the selector holds no other matcher, and the pod matcher matches those names and no other.
func TestBackendQueriesReadBackANameWithABackslashAndAQuote(t *testing.T) {
	namespace := `ns\"z\`
	names := []string{"web.v2-a1", "web.v2-b2", `x\y"z-0`}
	patterns := backendPodPatterns(names, backendPatternMax)
	if len(patterns) != 1 {
		t.Fatalf("patterns = %q, want one", patterns)
	}
	for key, q := range backendQueries(namespace, patterns[0]) {
		var labelNames []string
		var ns, pod *labels.Matcher
		for _, m := range selectorMatchers(t, q) {
			labelNames = append(labelNames, m.Name)
			switch m.Name {
			case "namespace":
				ns = m
			case "pod":
				pod = m
			}
		}
		sort.Strings(labelNames)
		if got := strings.Join(labelNames, ","); got != "__name__,container,container,namespace,pod" {
			t.Errorf("%s: matchers of %s, want __name__, namespace, pod and container twice", key, got)
		}
		if ns == nil || ns.Type != labels.MatchEqual || ns.Value != namespace {
			t.Errorf("%s: namespace matcher %v, want namespace=%q", key, ns, namespace)
		}
		if pod == nil || pod.Type != labels.MatchRegexp {
			t.Fatalf("%s: pod matcher %v, want pod=~", key, pod)
		}
		for _, n := range names {
			if !pod.Matches(n) {
				t.Errorf("%s: %q does not match %q", key, n, pod.Value)
			}
		}
		for _, n := range []string{"webxv2-a1", "web.v2-a", `x\y"z-00`, `xy"z-0`, `x\\y"z-0`} {
			if pod.Matches(n) {
				t.Errorf("%s: %q matches %q", key, n, pod.Value)
			}
		}
	}
}

// Names holding a quote and a backslash past one query: each pattern is under the size one query carries as the query's
// string writes it, a backslash before each quote and backslash included, and each name is in exactly one.
func TestBackendPodPatternsMeasureTheQuoteAndBackslashAsWritten(t *testing.T) {
	var names []string
	for i := 0; i < 2000; i++ {
		names = append(names, fmt.Sprintf(`we"b\-%05x"`, i*7919))
	}
	others := []string{`we"b\-00000`, `web\-00000"`, `we"b-00000"`, `we"b\-"`}
	patterns := backendPodPatterns(names, backendPatternMax)
	if len(patterns) < 2 {
		t.Fatalf("%d patterns: the names should not fit fewer", len(patterns))
	}
	matched := map[string]int{}
	for _, p := range patterns {
		if size := len(url.QueryEscape(writtenPattern(p))); size > backendPatternMax {
			t.Errorf("a pattern of %d bytes in a URL, past %d", size, backendPatternMax)
		}
		m := podMatcher(t, backendQueries("shop", p)["cpu"])
		for _, n := range names {
			if m.Matches(n) {
				matched[n]++
			}
		}
		for _, n := range others {
			if m.Matches(n) {
				t.Errorf("%q matches a pattern, which is not behind the Service", n)
			}
		}
	}
	for _, n := range names {
		if matched[n] != 1 {
			t.Errorf("%q is in %d patterns, want 1", n, matched[n])
		}
	}
}

// For names with no backslash or quote the queries are byte for byte those written before each value went through
// promString: the small case as text, and the many patterns of workloadPodNames by the digest they had.
func TestBackendQueriesOfPlainNamesAreUnchanged(t *testing.T) {
	patterns := backendPodPatterns([]string{"web-7d9f-d3e4f", "db-0", "web-7d9f-a1b2c", "web.v2-0"}, backendPatternMax)
	if len(patterns) != 1 {
		t.Fatalf("patterns = %q, want one", patterns)
	}
	want := map[string]string{
		"cpu":       `sum(rate(container_cpu_usage_seconds_total{namespace="shop",pod=~"db-0|web-7d9f-(a1b2c|d3e4f)|web\\.v2-0",container!="",container!="POD"}[5m])) * 1000`,
		"memory":    `sum(container_memory_working_set_bytes{namespace="shop",pod=~"db-0|web-7d9f-(a1b2c|d3e4f)|web\\.v2-0",container!="",container!="POD"})`,
		"pod_count": `count(count by(pod)(container_cpu_usage_seconds_total{namespace="shop",pod=~"db-0|web-7d9f-(a1b2c|d3e4f)|web\\.v2-0",container!="",container!="POD"}))`,
	}
	got := backendQueries("shop", patterns[0])
	for _, key := range []string{"cpu", "memory", "pod_count"} {
		if got[key] != want[key] {
			t.Errorf("%s query\n got %s\nwant %s", key, got[key], want[key])
		}
	}
	if len(got) != len(want) {
		t.Errorf("%d queries, want %d", len(got), len(want))
	}

	names, _ := workloadPodNames()
	many := backendPodPatterns(names, backendPatternMax)
	digest := sha256.New()
	for _, p := range many {
		q := backendQueries("shop", p)
		for _, key := range []string{"cpu", "memory", "pod_count"} {
			digest.Write([]byte(q[key] + "\n"))
		}
	}
	const wantDigest = "f483867fa245af4ce260b87b1868d96228d92d644672993752dc0254369ea248"
	if d := hex.EncodeToString(digest.Sum(nil)); d != wantDigest {
		t.Errorf("the %d patterns' queries have the digest %s, want %s", len(many), d, wantDigest)
	}
}

type promAnswers struct {
	mu      sync.Mutex
	queries []string
	answer  func(query string) ([]PrometheusQueryResult, error)
}

func (p *promAnswers) query(_ context.Context, q string) ([]PrometheusQueryResult, error) {
	p.mu.Lock()
	p.queries = append(p.queries, q)
	p.mu.Unlock()
	return p.answer(q)
}

func manyPods(n int) []string {
	pods := make([]string, n)
	for i := range pods {
		pods[i] = fmt.Sprintf("backend-%04d-%s", i, strings.Repeat("x", 40))
	}
	return pods
}

// The sum adds what each matcher's three queries answer; a sum Prometheus had no series for stays unknown.
func TestSumBackendUsageAddsEachMatchersAnswers(t *testing.T) {
	pods := manyPods(400)
	p := &promAnswers{answer: func(q string) ([]PrometheusQueryResult, error) {
		switch {
		case strings.HasPrefix(q, "count("):
			return []PrometheusQueryResult{{Value: 100}}, nil
		case strings.Contains(q, "container_memory_working_set_bytes"):
			return nil, nil
		default:
			return []PrometheusQueryResult{{Value: 2.5}}, nil
		}
	}}
	got, err := SumBackendUsage(context.Background(), "shop", pods, p.query)
	if err != nil {
		t.Fatal(err)
	}
	matchers := len(backendPodPatterns(pods, backendPatternMax))
	if matchers < 2 || got.Queries != 3*matchers || len(p.queries) != 3*matchers {
		t.Fatalf("%d matchers, Queries %d, asked %d", matchers, got.Queries, len(p.queries))
	}
	if !got.Available || got.Pods != 400 || got.CPU == nil || *got.CPU != 2.5*float64(matchers) || got.PodCount == nil || *got.PodCount != 100*float64(matchers) || got.Memory != nil {
		t.Fatalf("usage = %+v", got)
	}
	for _, q := range p.queries {
		if !strings.Contains(q, `namespace="shop"`) || !strings.Contains(q, `container!="",container!="POD"`) {
			t.Errorf("query %s is not the drawer's", q)
		}
	}
}

func TestSumBackendUsageSaysWhatItDidNotSum(t *testing.T) {
	never := func(q string) ([]PrometheusQueryResult, error) {
		t.Errorf("asked %s", q)
		return nil, nil
	}
	cases := []struct {
		name      string
		namespace string
		pods      []string
		want      func(BackendUsage, error) bool
	}{
		{"no ready pods", "shop", nil, func(u BackendUsage, err error) bool {
			return err == nil && u.Available && u.Pods == 0 && u.CPU == nil && u.Queries == 0
		}},
		{"past the queries one sum takes", "shop", manyPods(30000), func(u BackendUsage, err error) bool {
			return err == nil && u.Available && u.Pods == 30000 && u.PastQueries && u.Queries > backendQueriesMax && u.CPU == nil
		}},
		{"a namespace that is not a Kubernetes name", `shop"}or vector(1)`, manyPods(3), func(u BackendUsage, err error) bool {
			return errors.Is(err, ErrBadInput)
		}},
	}
	for _, c := range cases {
		p := &promAnswers{answer: never}
		got, err := SumBackendUsage(context.Background(), c.namespace, c.pods, p.query)
		if !c.want(got, err) {
			t.Errorf("%s: %+v %v", c.name, got, err)
		}
	}
	p := &promAnswers{answer: func(string) ([]PrometheusQueryResult, error) { return nil, errors.New("prometheus did not answer") }}
	if _, err := SumBackendUsage(context.Background(), "shop", manyPods(3), p.query); err == nil || err.Error() != "prometheus did not answer" {
		t.Errorf("a failed query gave %v, want its error", err)
	}
}

// The pods are those of the Service's ready endpoints, each once, as the drawer reads them from the describe answer.
func TestServiceBackendPodsAreTheReadyEndpointsPods(t *testing.T) {
	ready, notReady := true, false
	pod := func(name, namespace string) *corev1.ObjectReference {
		return &corev1.ObjectReference{Kind: "Pod", Name: name, Namespace: namespace}
	}
	slice := func(name string, endpoints ...discoveryv1.Endpoint) discoveryv1.EndpointSlice {
		return discoveryv1.EndpointSlice{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop"}, Endpoints: endpoints}
	}
	got := backendPodsOf([]discoveryv1.EndpointSlice{
		slice("web-ipv4",
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.1"}, TargetRef: pod("web-1", "shop")},
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.2"}, Conditions: discoveryv1.EndpointConditions{Ready: &ready}, TargetRef: pod("web-0", "")},
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.3"}, Conditions: discoveryv1.EndpointConditions{Ready: &notReady}, TargetRef: pod("web-2", "shop")},
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.4"}},
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.5"}, TargetRef: pod("elsewhere-0", "other")},
			discoveryv1.Endpoint{TargetRef: pod("no-address", "shop")},
			discoveryv1.Endpoint{Addresses: []string{"10.0.0.6"}, TargetRef: &corev1.ObjectReference{Kind: "Node", Name: "node-1"}},
		),
		slice("web-ipv6", discoveryv1.Endpoint{Addresses: []string{"fd00::1"}, TargetRef: pod("web-1", "shop")}),
	}, "shop")
	if strings.Join(got, ",") != "web-0,web-1" {
		t.Fatalf("pods = %v, want web-0,web-1", got)
	}
}
