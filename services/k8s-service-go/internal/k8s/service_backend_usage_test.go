package k8s

import (
	"context"
	"errors"
	"fmt"
	"net/url"
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

// A pattern written for names that fit one query is the screen's (serviceBackend.ts podNamesPattern).
func TestBackendPodPatternsWriteWhatTheScreenWrites(t *testing.T) {
	got := backendPodPatterns([]string{"web-7d9f-d3e4f", "db-0", "web-7d9f-a1b2c", "web.v2-0", "db-0"}, backendPatternMax)
	if want := []string{`db-0|web-7d9f-(a1b2c|d3e4f)|web\\.v2-0`}; strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("patterns = %q, want %q", got, want)
	}
}

// Past one query the names go into as many patterns as it takes: each under the size one query carries, each name in
// exactly one, and no other pod of the namespace in any, as Prometheus reads the matchers.
func TestBackendPodPatternsNameEachPodOnceAndNoOther(t *testing.T) {
	var names, others []string
	for i := 0; i < 3000; i++ {
		names = append(names, fmt.Sprintf("web-7d9f8c6b5-%05x", i*7919))
	}
	for i := 0; i < 700; i++ {
		names = append(names, fmt.Sprintf("db-%d", i))
		others = append(others, fmt.Sprintf("db-%d", i+700), fmt.Sprintf("xdb-%d", i))
	}
	names = append(names, "api.v2-0", "api.v2-1", "solo")
	others = append(others, "apixv2-0", "web-7d9f8c6b5-", "web-7d9f8c6b5-zzzzz", "sol", "solo-0", "db-")
	patterns := backendPodPatterns(names, backendPatternMax)
	if len(patterns) < 3 {
		t.Fatalf("%d patterns: the names should not fit fewer", len(patterns))
	}
	matched := map[string]int{}
	for _, p := range patterns {
		if size := len(url.QueryEscape(p)); size > backendPatternMax {
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
