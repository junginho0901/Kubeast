package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/protectedns"
)

// twoRestarting is a namespace where web's pod restarts eight times as often as before and api's three times: by the
// counts web comes first, while web calls api, whose calls fail (the call graph puts api first).
type twoRestarting struct {
	mu    sync.Mutex
	reads int
}

func (f *twoRestarting) CollectIssues(context.Context, k8s.IssuesOptions) ([]k8s.Issue, error) {
	return nil, nil
}

func (f *twoRestarting) GetPods(_ context.Context, namespace, _ string) ([]map[string]interface{}, error) {
	return []map[string]interface{}{
		{"name": "web-1", "namespace": namespace, "owner_references": []map[string]interface{}{{"kind": "Deployment", "name": "web"}}},
		{"name": "api-1", "namespace": namespace, "owner_references": []map[string]interface{}{{"kind": "Deployment", "name": "api"}}},
	}, nil
}

func (f *twoRestarting) PrometheusAvailable(context.Context) bool { return true }

func (f *twoRestarting) ProtectedNamespaces(context.Context) protectedns.Namespaces {
	return protectedns.Namespaces{NodeShell: "kubeast-node-shell"}
}

func (f *twoRestarting) PrometheusQueryAt(_ context.Context, q string, at time.Time) ([]k8s.PrometheusQueryResult, error) {
	f.mu.Lock()
	f.reads++
	f.mu.Unlock()
	if !strings.Contains(q, "kube_pod_container_status_restarts_total") {
		return nil, nil
	}
	web, api := 1.0, 1.0
	if at.Equal(anomalyNow) {
		web, api = 8, 3
	}
	return []k8s.PrometheusQueryResult{{Metric: map[string]interface{}{"pod": "web-1"}, Value: web}, {Metric: map[string]interface{}{"pod": "api-1"}, Value: api}}, nil
}

// orderGraph is callsGraph with api's pod: web's pod is web-1 (selected by web-svc), api's api-1.
var orderGraph = map[string]interface{}{
	"nodes": []map[string]interface{}{
		{"id": "Deployment/shop/web", "kind": "Deployment", "name": "web", "namespace": "shop", "health": "warn"},
		{"id": "Pod/shop/web-1", "kind": "Pod", "name": "web-1", "namespace": "shop"},
		{"id": "Service/shop/web-svc", "kind": "Service", "name": "web-svc", "namespace": "shop"},
		{"id": "Deployment/shop/api", "kind": "Deployment", "name": "api", "namespace": "shop", "health": "error"},
		{"id": "Pod/shop/api-1", "kind": "Pod", "name": "api-1", "namespace": "shop"},
	},
	"edges": []map[string]interface{}{
		{"source": "Deployment/shop/web", "target": "Pod/shop/web-1", "type": "owns"},
		{"source": "Deployment/shop/api", "target": "Pod/shop/api-1", "type": "owns"},
		{"source": "Service/shop/web-svc", "target": "Pod/shop/web-1", "type": "selects"},
	},
}

func callOrderHandler(cfg config.Config) (*Handler, *twoRestarting, *fixedCalls, *int) {
	f := &twoRestarting{}
	calls := &fixedCalls{fakeCalls: callsSource()}
	graphReads := 0
	cfg.AnomalyRankEnabled = true
	h := &Handler{cfg: cfg, anomalySrc: f, netdropsSrc: calls, anomalyNow: func() time.Time { return anomalyNow },
		anomalyGraph: func(context.Context, string) (map[string]interface{}, error) { graphReads++; return orderGraph, nil }}
	return h, f, calls, &graphReads
}

func findingOrder(res anomaly.Result) string {
	out := make([]string, 0, len(res.Findings))
	for _, f := range res.Findings {
		out = append(out, f.Check+":"+f.Target)
	}
	return strings.Join(out, ",")
}

// Off, the narrowing reads no graph and no call, and the answer has no call_order: the 2-a order, as before.
func TestAnomaliesCallOrderOffReadsNothingMore(t *testing.T) {
	h, _, calls, graphReads := callOrderHandler(config.Config{})
	w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "call_order") || *graphReads != 0 || len(calls.queries) != 0 || len(calls.at) != 0 {
		t.Fatalf("%d %s graph %d calls %v", w.Code, w.Body, *graphReads, calls.queries)
	}
	if got := findingOrder(res); got != "restarts:Pod/web-1,restarts:Pod/api-1" {
		t.Fatalf("2-a order %s", got)
	}
	if res.StoreQueries != 6 {
		t.Fatalf("store queries %d", res.StoreQueries)
	}
}

// On, the call graph is read over the narrowing's own window, at its end, from the queries the checks left; api,
// whose callees are all well, goes before web, which calls it.
func TestAnomaliesCallOrderPutsTheCauseBeforeItsVictim(t *testing.T) {
	h, _, calls, graphReads := callOrderHandler(config.Config{CallGraphEnabled: true})
	w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusOK || *graphReads != 1 {
		t.Fatalf("%d %s graph %d", w.Code, w.Body, *graphReads)
	}
	if got := findingOrder(res); got != "restarts:Pod/api-1,restarts:Pod/web-1" {
		t.Fatalf("order %s", got)
	}
	co := res.CallOrder
	if co == nil || !co.Applied || co.Moved != 2 || len(co.Suspects) != 2 || co.Suspects[0] != "Deployment/shop/api" || co.Reason != "" {
		t.Fatalf("call_order %+v", co)
	}
	for _, at := range calls.at {
		if !at.Equal(anomalyNow) {
			t.Fatalf("read at %s", at)
		}
	}
	for _, b := range calls.between {
		if !b[0].Equal(anomalyNow.Add(-time.Hour)) || !b[1].Equal(anomalyNow) {
			t.Fatalf("labels over %v", b)
		}
	}
	// the 90th percentile ranks nothing and is not read; the queries stay within features.anomalyRank.maxQueries
	if calls.plain != 0 || calls.count("traces_service_graph_request_server_seconds_bucket") != 0 || res.StoreQueries > 12 || res.StoreQueries != 6+len(calls.at)+len(calls.between) {
		t.Fatalf("plain %d queries %v store %d", calls.plain, calls.queries, res.StoreQueries)
	}
	if !strings.Contains(w.Body.String(), `"call_order":{"applied":true`) {
		t.Fatalf("answer %s", w.Body)
	}
}

// The checks take their queries first: with none left for the call graph the 2-a order stays and call_order says why.
func TestAnomaliesCallOrderWithinTheStoreQueries(t *testing.T) {
	h, _, calls, _ := callOrderHandler(config.Config{CallGraphEnabled: true, AnomalyRankMaxQueries: 7})
	w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := findingOrder(res); got != "restarts:Pod/web-1,restarts:Pod/api-1" {
		t.Fatalf("order %s", got)
	}
	co := res.CallOrder
	if co == nil || co.Applied || co.Moved != 0 || !strings.Contains(co.Reason, budgetSpent) || res.StoreQueries != 7 {
		t.Fatalf("call_order %+v store %d", co, res.StoreQueries)
	}
	if len(calls.at)+len(calls.between) > 1 {
		t.Fatalf("read past the budget: %v %v", calls.at, calls.between)
	}
}

// One workload among the findings has nothing to order: no call graph read and no call_order.
func TestAnomaliesCallOrderNeedsTwoWorkloads(t *testing.T) {
	h, _, calls, graphReads := callOrderHandler(config.Config{CallGraphEnabled: true})
	h.anomalyGraph = func(context.Context, string) (map[string]interface{}, error) {
		*graphReads++
		g := map[string]interface{}{"nodes": orderGraph["nodes"].([]map[string]interface{})[:3], "edges": orderGraph["edges"]}
		return g, nil
	}
	w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if w.Code != http.StatusOK || res.CallOrder != nil || len(calls.at) != 0 || *graphReads != 1 {
		t.Fatalf("%d %s calls %v", w.Code, w.Body, calls.at)
	}
}

// A graph that cannot be read leaves the 2-a order with the reason.
func TestAnomaliesCallOrderGraphFailure(t *testing.T) {
	h, _, _, _ := callOrderHandler(config.Config{CallGraphEnabled: true})
	h.anomalyGraph = func(context.Context, string) (map[string]interface{}, error) { return nil, errors.New("forbidden") }
	_, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
	if res.CallOrder == nil || res.CallOrder.Applied || !strings.Contains(res.CallOrder.Reason, "the namespace's graph") || findingOrder(res) != "restarts:Pod/web-1,restarts:Pod/api-1" {
		t.Fatalf("%+v %s", res.CallOrder, findingOrder(res))
	}
	b, _ := json.Marshal(res.CallOrder)
	if !strings.Contains(string(b), `"applied":false`) {
		t.Fatalf("%s", b)
	}
}
