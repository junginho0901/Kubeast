package handler

import (
	"context"
	"errors"
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
	edge := func(client, server string) map[string]interface{} {
		return map[string]interface{}{"client": client, "server": server}
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
