package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/callgraph"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeCalls answers like a Prometheus holding Tempo's service graph metrics (no namespace dimension) and the Hubble metrics.
type fakeCalls struct {
	labels  map[string][]string
	queries []string
	// drops: also answer the Hubble drop metric (web → api refused by a policy)
	drops bool
}

func (f *fakeCalls) PrometheusAvailable(context.Context) bool { return true }

func (f *fakeCalls) PrometheusLabels(_ context.Context, label, selector string, since time.Duration, _ int) ([]string, error) {
	if label != "" || since <= 0 {
		return nil, errors.New("unexpected labels call")
	}
	return f.labels[selector], nil
}

func (f *fakeCalls) PrometheusQuery(_ context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	f.queries = append(f.queries, q)
	// the namespace labels a metric with the dimension has; read only when the label names say so (Shape)
	edge := func(client, server string) map[string]interface{} {
		return map[string]interface{}{"client": client, "server": server, "client_k8s_namespace_name": "shop", "server_k8s_namespace_name": "shop"}
	}
	switch {
	case strings.Contains(q, callgraph.RequestsMetric):
		return []k8s.PrometheusQueryResult{{Metric: edge("web-svc", "api"), Value: 1000}}, nil
	case strings.Contains(q, callgraph.FailedMetric):
		return []k8s.PrometheusQueryResult{{Metric: edge("web-svc", "api"), Value: 400}}, nil
	case strings.Contains(q, callgraph.ServerSeconds):
		return []k8s.PrometheusQueryResult{{Metric: edge("web-svc", "api"), Value: 1.5}}, nil
	case strings.Contains(q, nettraffic.TCPMetric):
		return []k8s.PrometheusQueryResult{{Metric: map[string]interface{}{"source_namespace": "shop", "source_workload": "web", "source_workload_kind": "Deployment",
			"destination_namespace": "shop", "destination_workload": "api", "destination_workload_kind": "Deployment", "traffic_direction": "ingress"}, Value: 30}}, nil
	case f.drops && strings.Contains(q, netdrops.Metric):
		return []k8s.PrometheusQueryResult{{Metric: map[string]interface{}{"source_namespace": "shop", "source_workload": "web", "source_workload_kind": "Deployment",
			"destination_namespace": "shop", "destination_workload": "api", "destination_workload_kind": "Deployment", "traffic_direction": "ingress", "reason": "POLICY_DENIED"}, Value: 6}}, nil
	}
	return nil, nil
}

func (f *fakeCalls) NetdropsTarget(context.Context, string, string, string, bool) (*netdrops.Workload, []string, bool, error) {
	return nil, nil, false, errors.New("not used")
}

func (f *fakeCalls) count(metric string) int {
	n := 0
	for _, q := range f.queries {
		if strings.Contains(q, metric) {
			n++
		}
	}
	return n
}

var callsGraph = map[string]interface{}{
	"nodes": []map[string]interface{}{
		{"id": "Deployment/shop/web", "kind": "Deployment", "name": "web", "namespace": "shop", "health": "warn"},
		{"id": "Pod/shop/web-1", "kind": "Pod", "name": "web-1", "namespace": "shop"},
		{"id": "Service/shop/web-svc", "kind": "Service", "name": "web-svc", "namespace": "shop"},
		{"id": "Deployment/shop/api", "kind": "Deployment", "name": "api", "namespace": "shop", "health": "error"},
	},
	"edges": []map[string]interface{}{
		{"source": "Deployment/shop/web", "target": "Pod/shop/web-1", "type": "owns"},
		{"source": "Service/shop/web-svc", "target": "Pod/shop/web-1", "type": "selects"},
	},
}

func callsSource() *fakeCalls {
	return &fakeCalls{labels: map[string][]string{
		callgraph.RequestsMetric: {"__name__", "client", "server", "connection_type"},
		nettraffic.TCPMetric:     tcpShape,
	}}
}

func TestResourceGraphCallsOffReadsNothing(t *testing.T) {
	src := callsSource()
	h := &Handler{netdropsSrc: src}
	res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", flowReader), "shop", callsGraph, "")
	if err != nil || res.Available || res.Reason != callgraph.ReasonOff || len(src.queries) != 0 || res.Edges == nil {
		t.Fatalf("%+v %v queries %v", res, err, src.queries)
	}
}

func TestResourceGraphCallsBothSources(t *testing.T) {
	src := callsSource()
	h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
	res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls&range=30m", "self", "shop", flowReader), "shop", callsGraph, "30m")
	if err != nil || !res.Available || res.Range != "30m0s" || len(res.Sources) != 2 || !res.Sources[0].Read || !res.Sources[1].Read {
		t.Fatalf("%+v %v", res, err)
	}
	if len(res.Edges) != 1 {
		t.Fatalf("edges %+v", res.Edges)
	}
	e := res.Edges[0]
	if e.From.ID != "Deployment/shop/web" || e.To.ID != "Deployment/shop/api" || e.Requests != 1000 || e.Errors != 400 || e.P90Ms != 1500 || e.Connections != 30 || len(e.Sources) != 2 {
		t.Fatalf("web → api: %+v", e)
	}
	if len(res.Suspects) != 2 || res.Suspects[0].ID != "Deployment/shop/api" || len(res.Paths) != 1 || res.Paths[0][0] != "Deployment/shop/api" {
		t.Fatalf("suspects %+v paths %v", res.Suspects, res.Paths)
	}
	for _, q := range src.queries {
		if !strings.Contains(q, "[1800s]") {
			t.Fatalf("range: %s", q)
		}
	}
	if src.count(callgraph.RequestsMetric) != 1 || src.count(callgraph.FailedMetric) != 1 || src.count(callgraph.ServerSeconds) != 1 {
		t.Fatalf("one query each: %v", src.queries)
	}
}

// A grant limited to namespaces reads no service graph series (they name every namespace's services) but the traffic
// lines of its namespace; a reader without resource.networkflow.read gets the traces only.
func TestResourceGraphCallsKeepToTheGrant(t *testing.T) {
	src := callsSource()
	h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", scoped), "shop", callsGraph, "")
	if err != nil || res.Sources[0].Read || res.Sources[0].Reason != callgraph.ReasonNamespaceLimited || !res.Sources[1].Read {
		t.Fatalf("scoped: %+v %v", res.Sources, err)
	}
	if src.count("traces_service_graph") != 0 {
		t.Fatalf("scoped read the service graph: %v", src.queries)
	}
	src = callsSource()
	h.netdropsSrc = src
	podsOnly := auth.TokenPayload{UserID: "u2", Email: "pods@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read", "resource.objects.read"}}}
	res, err = h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", podsOnly), "shop", callsGraph, "")
	if err != nil || !res.Sources[0].Read || res.Sources[1].Read || res.Sources[1].Reason != callgraph.ReasonPermission || src.count(nettraffic.TCPMetric) != 0 {
		t.Fatalf("no flow permission: %+v %v %v", res.Sources, err, src.queries)
	}
	// a bad range or namespace is the caller's
	if _, err := h.resourceGraphCalls(logSearchRequestAs("/", "self", "shop", flowReader), "shop", callsGraph, "3d"); !errors.Is(err, k8s.ErrBadInput) {
		t.Fatalf("range: %v", err)
	}
	if _, err := h.resourceGraphCalls(logSearchRequestAs("/", "self", "Shop", flowReader), "Shop", callsGraph, ""); !errors.Is(err, k8s.ErrBadInput) {
		t.Fatalf("namespace: %v", err)
	}
}

// Without the namespace dimension the trace source says its services are placed by name, the ends say _unscoped and
// the 90th percentile is capped like the other two queries; the drops' reasons reach the edge. With the dimension none
// of that, and the same number of reads.
func TestResourceGraphCallsNameOnlyAndDropReasons(t *testing.T) {
	src := callsSource()
	src.drops = true
	src.labels[netdrops.Metric] = dropsShape
	h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
	res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", flowReader), "shop", callsGraph, "")
	if err != nil || len(res.Edges) != 1 || !res.Sources[0].Read || res.Sources[0].Detail != callgraph.DetailUnscoped {
		t.Fatalf("%+v %v", res, err)
	}
	e := res.Edges[0]
	if e.From.MatchedBy != "service_selector_unscoped" || e.To.MatchedBy != "workload_name_unscoped" || e.Dropped != 6 ||
		len(e.DropReasons) != 1 || e.DropReasons[0].Reason != "POLICY_DENIED" || e.DropReasons[0].Count != 6 {
		t.Fatalf("web → api: %+v", e)
	}
	if res.SuspectsTotal != 2 || res.NoStart != "" {
		t.Fatalf("suspects %d no_start %q", res.SuspectsTotal, res.NoStart)
	}
	for _, q := range src.queries {
		if strings.Contains(q, callgraph.ServerSeconds) && !strings.HasPrefix(q, "topk(500, histogram_quantile(0.9,") {
			t.Fatalf("p90 uncapped: %s", q)
		}
	}
	if src.count(callgraph.RequestsMetric) != 1 || src.count(callgraph.FailedMetric) != 1 || src.count(callgraph.ServerSeconds) != 1 {
		t.Fatalf("one query each: %v", src.queries)
	}

	src = callsSource()
	src.labels[callgraph.RequestsMetric] = []string{"__name__", "client", "server", "client_k8s_namespace_name", "server_k8s_namespace_name"}
	h.netdropsSrc = src
	res, err = h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", flowReader), "shop", callsGraph, "")
	if err != nil || len(res.Edges) != 1 || res.Sources[0].Detail != "" || res.Edges[0].From.MatchedBy != "service_selector" || res.Edges[0].To.MatchedBy != "workload_name" {
		t.Fatalf("namespace dimension: %+v %v", res, err)
	}
	if src.count("topk(") != 0 || src.count(callgraph.ServerSeconds) != 1 {
		t.Fatalf("namespace dimension, no cap: %v", src.queries)
	}
}

// cappedCalls answers the requests and failed queries with rows of its own, as a Prometheus whose metric names no
// namespace answers each topk.
type cappedCalls struct {
	*fakeCalls
	requests, failed []k8s.PrometheusQueryResult
}

func (c *cappedCalls) PrometheusQuery(ctx context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	switch {
	case strings.Contains(q, callgraph.RequestsMetric):
		c.queries = append(c.queries, q)
		return c.requests, nil
	case strings.Contains(q, callgraph.FailedMetric):
		c.queries = append(c.queries, q)
		return c.failed, nil
	}
	return c.fakeCalls.PrometheusQuery(ctx, q)
}

// A capped query that comes back full says so in the answer, with the same reads. Requests full of 500 edges of other
// namespaces leave cart's (the 501st) out: no edge, and the trace source and the answer say truncated. Failed full of 500
// other edges with 20 each leave cart's 10 out: its errors and error_ratio are null, not 0.
func TestResourceGraphCallsSayWhatTheCappedQueriesLeftOut(t *testing.T) {
	cartGraph := map[string]interface{}{
		"nodes": []map[string]interface{}{{"id": "Deployment/shop/cart", "kind": "Deployment", "name": "cart", "namespace": "shop", "health": "ok"}},
		"edges": []map[string]interface{}{},
	}
	row := func(client, server string, v float64) k8s.PrometheusQueryResult {
		return k8s.PrometheusQueryResult{Metric: map[string]interface{}{"client": client, "server": server}, Value: v}
	}
	others := func(v float64) []k8s.PrometheusQueryResult {
		var out []k8s.PrometheusQueryResult
		for i := 0; i < callgraph.MaxSeries; i++ {
			out = append(out, row(fmt.Sprintf("else%d", i), "other", v))
		}
		return out
	}
	// no resource.networkflow.read: the traces alone
	reader := auth.TokenPayload{UserID: "u2", Email: "pods@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read", "resource.objects.read"}}}
	read := func(src *cappedCalls) (callgraph.Result, map[string]interface{}) {
		h := &Handler{netdropsSrc: src, cfg: config.Config{CallGraphEnabled: true}}
		res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls", "self", "shop", reader), "shop", cartGraph, "")
		if err != nil || len(res.Sources) != 2 || !res.Sources[0].Read || res.Sources[1].Read {
			t.Fatalf("%+v %v", res, err)
		}
		raw, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		if src.count(callgraph.RequestsMetric) != 1 || src.count(callgraph.FailedMetric) != 1 || src.count(callgraph.ServerSeconds) != 1 {
			t.Fatalf("one query each: %v", src.queries)
		}
		return res, m
	}
	traceSource := func(m map[string]interface{}) map[string]interface{} {
		return m["sources"].([]interface{})[0].(map[string]interface{})
	}

	res, m := read(&cappedCalls{fakeCalls: callsSource(), requests: others(1000)})
	if len(res.Edges) != 0 || res.EdgesTotal != 0 || !res.Truncated || traceSource(m)["truncated"] != true {
		t.Fatalf("requests full: no edge, truncated in the answer and the trace source, got %v", m)
	}

	res, m = read(&cappedCalls{fakeCalls: callsSource(), requests: []k8s.PrometheusQueryResult{row("edge", "cart", 100000)}, failed: others(20)})
	if len(res.Edges) != 1 || res.Edges[0].To.ID != "Deployment/shop/cart" || res.Truncated || traceSource(m)["truncated"] != true {
		t.Fatalf("failed full: cart's edge, the trace source truncated, the edges whole, got %v", m)
	}
	edge := m["edges"].([]interface{})[0].(map[string]interface{})
	if errs, ok := edge["errors"]; !ok || errs != nil {
		t.Fatalf("cart's errors not known: null, got %v", edge)
	}
	if ratio, ok := edge["error_ratio"]; !ok || ratio != nil {
		t.Fatalf("cart's error_ratio not known: null, got %v", edge)
	}

	// one failed row fewer: the answer is whole, cart's failed calls are 0 and the source is not truncated
	src := &cappedCalls{fakeCalls: callsSource(), requests: []k8s.PrometheusQueryResult{row("edge", "cart", 100000)}, failed: others(20)[1:]}
	_, m = read(src)
	edge = m["edges"].([]interface{})[0].(map[string]interface{})
	if _, ok := edge["errors"]; ok || traceSource(m)["truncated"] != nil {
		t.Fatalf("failed short of the cap: errors 0 (left out), not truncated, got %v", m)
	}
}
