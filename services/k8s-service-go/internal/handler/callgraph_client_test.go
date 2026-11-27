package handler

import (
	"context"
	"encoding/json"
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

// clientCalls is fakeCalls that also answers the client side's 90th percentile: client seconds for web-svc → api, nil
// for a Prometheus without that metric, or err. It counts every read, label reads too.
type clientCalls struct {
	*fakeCalls
	client []k8s.PrometheusQueryResult
	err    error
	// quiet: the traces count no call
	quiet bool
	reads int
}

func (c *clientCalls) PrometheusQuery(ctx context.Context, q string) ([]k8s.PrometheusQueryResult, error) {
	c.reads++
	switch {
	case strings.Contains(q, callgraph.ClientSeconds):
		c.queries = append(c.queries, q)
		return c.client, c.err
	case c.quiet && strings.Contains(q, "traces_service_graph"):
		c.queries = append(c.queries, q)
		return nil, nil
	}
	return c.fakeCalls.PrometheusQuery(ctx, q)
}

func (c *clientCalls) PrometheusLabels(ctx context.Context, label, selector string, since time.Duration, limit int) ([]string, error) {
	c.reads++
	return c.fakeCalls.PrometheusLabels(ctx, label, selector, since, limit)
}

func clientSide(seconds float64, connection string) []k8s.PrometheusQueryResult {
	m := map[string]interface{}{"client": "web-svc", "server": "api", "client_k8s_namespace_name": "shop", "server_k8s_namespace_name": "shop"}
	if connection != "" {
		m["connection_type"] = connection
	}
	return []k8s.PrometheusQueryResult{{Metric: m, Value: seconds}}
}

func newClientCalls(namespaced bool, client []k8s.PrometheusQueryResult) *clientCalls {
	src := callsSource()
	src.drops = true
	src.labels[netdrops.Metric] = dropsShape
	if namespaced {
		src.labels[callgraph.RequestsMetric] = []string{"__name__", "client", "server", "connection_type", "client_k8s_namespace_name", "server_k8s_namespace_name"}
	}
	return &clientCalls{fakeCalls: src, client: client}
}

var clientOn = config.Config{CallGraphEnabled: true, CallGraphClientLatency: true}

func readCalls(t *testing.T, cfg config.Config, src netdropsSource, reader auth.TokenPayload) (callgraph.Result, string) {
	t.Helper()
	h := &Handler{netdropsSrc: src, cfg: cfg}
	res, err := h.resourceGraphCalls(logSearchRequestAs("/api/v1/namespaces/shop/resource-graph?include=calls&range=30m", "self", "shop", reader), "shop", callsGraph, "30m")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	return res, string(raw)
}

// traceQueries are the service graph queries asked, in order.
func traceQueries(src *clientCalls) string {
	var out []string
	for _, q := range src.queries {
		if strings.Contains(q, "traces_service_graph") {
			out = append(out, q)
		}
	}
	return strings.Join(out, "\n")
}

// What include calls answers and asks with features.callGraph on and clientLatency off, as main 981d53f65 gave it.
var callsBefore = map[bool]struct{ answer, queries string }{
	false: {
		`{"available":true,"range":"30m0s","sources":[{"source":"traces","read":true,"detail":"the metric has no namespace dimension: services are placed by name, and a service of the same name in another namespace counts here (matched_by ends in _unscoped)","series":1},{"source":"network","read":true,"series":1}],"paths":[["Deployment/shop/api","Deployment/shop/web"]],"suspects":[{"id":"Deployment/shop/api","health":"error","signals":["health","calls_fail","dropped"],"failing_callers":["Deployment/shop/web"]},{"id":"Deployment/shop/web","health":"warn","signals":["health"],"failing_callees":["Deployment/shop/api"]}],"suspects_total":2,"edges_total":1,"edges":[{"from":{"id":"Deployment/shop/web","namespace":"shop","kind":"Deployment","name":"web","matched_by":"service_selector_unscoped"},"to":{"id":"Deployment/shop/api","namespace":"shop","kind":"Deployment","name":"api","matched_by":"workload_name_unscoped"},"sources":["traces","network"],"requests":1000,"errors":400,"error_ratio":0.4,"p90_ms":1500,"connections":30,"dropped":6,"drop_reasons":[{"reason":"POLICY_DENIED","count":6}]}]}`,
		`topk(500, sum by (client, server) (increase(traces_service_graph_request_total[1800s])))
topk(500, sum by (client, server) (increase(traces_service_graph_request_failed_total[1800s])))
topk(500, histogram_quantile(0.9, sum by (le, client, server) (rate(traces_service_graph_request_server_seconds_bucket[1800s]))))`,
	},
	true: {
		`{"available":true,"range":"30m0s","sources":[{"source":"traces","read":true,"series":1},{"source":"network","read":true,"series":1}],"paths":[["Deployment/shop/api","Deployment/shop/web"]],"suspects":[{"id":"Deployment/shop/api","health":"error","signals":["health","calls_fail","dropped"],"failing_callers":["Deployment/shop/web"]},{"id":"Deployment/shop/web","health":"warn","signals":["health"],"failing_callees":["Deployment/shop/api"]}],"suspects_total":2,"edges_total":1,"edges":[{"from":{"id":"Deployment/shop/web","namespace":"shop","kind":"Deployment","name":"web","matched_by":"service_selector"},"to":{"id":"Deployment/shop/api","namespace":"shop","kind":"Deployment","name":"api","matched_by":"workload_name"},"sources":["traces","network"],"requests":1000,"errors":400,"error_ratio":0.4,"p90_ms":1500,"connections":30,"dropped":6,"drop_reasons":[{"reason":"POLICY_DENIED","count":6}]}]}`,
		`sum by (client, server, client_k8s_namespace_name, server_k8s_namespace_name) (increase(traces_service_graph_request_total{server_k8s_namespace_name="shop"}[1800s])) or sum by (client, server, client_k8s_namespace_name, server_k8s_namespace_name) (increase(traces_service_graph_request_total{client_k8s_namespace_name="shop"}[1800s]))
sum by (client, server, client_k8s_namespace_name, server_k8s_namespace_name) (increase(traces_service_graph_request_failed_total{server_k8s_namespace_name="shop"}[1800s])) or sum by (client, server, client_k8s_namespace_name, server_k8s_namespace_name) (increase(traces_service_graph_request_failed_total{client_k8s_namespace_name="shop"}[1800s]))
histogram_quantile(0.9, sum by (le, client, server, client_k8s_namespace_name, server_k8s_namespace_name) (rate(traces_service_graph_request_server_seconds_bucket{server_k8s_namespace_name="shop"}[1800s])) or sum by (le, client, server, client_k8s_namespace_name, server_k8s_namespace_name) (rate(traces_service_graph_request_server_seconds_bucket{client_k8s_namespace_name="shop"}[1800s])))`,
	},
}

// With clientLatency off the answer is the one before it to the byte, and so is every query asked, with and without the
// namespace labels; a value that does not turn a switch on leaves it off.
func TestResourceGraphCallsWithoutClientLatencyAreAsBefore(t *testing.T) {
	for namespaced, before := range callsBefore {
		for _, value := range []string{"", "false", "0", "enabled"} {
			t.Setenv("CALL_GRAPH_ENABLED", "true")
			t.Setenv("CALL_GRAPH_CLIENT_LATENCY", value)
			src := newClientCalls(namespaced, clientSide(9, ""))
			if _, raw := readCalls(t, config.Load(), src, flowReader); raw != before.answer {
				t.Errorf("namespaced %v, %q:\n%s\nwant\n%s", namespaced, value, raw, before.answer)
			}
			if got := traceQueries(src); got != before.queries {
				t.Errorf("namespaced %v, %q asks\n%s\nwant\n%s", namespaced, value, got, before.queries)
			}
		}
	}
	// the call graph itself off: nothing is read whatever clientLatency says
	src := newClientCalls(false, clientSide(9, ""))
	if res, _ := readCalls(t, config.Config{CallGraphClientLatency: true}, src, flowReader); res.Available || res.Reason != callgraph.ReasonOff || src.reads != 0 {
		t.Fatalf("callGraph off: %+v, %d reads", res, src.reads)
	}
}

// With clientLatency on one query more puts what the caller measured beside the callee's, and nothing else of the answer
// changes: the failing workloads, their order and the paths are the same.
func TestResourceGraphCallsPutTheClientSideBesideTheServers(t *testing.T) {
	t.Setenv("CALL_GRAPH_ENABLED", "true")
	t.Setenv("CALL_GRAPH_CLIENT_LATENCY", "true")
	for namespaced, before := range callsBefore {
		off, on := newClientCalls(namespaced, nil), newClientCalls(namespaced, clientSide(4.75, ""))
		readCalls(t, config.Config{CallGraphEnabled: true}, off, flowReader)
		res, raw := readCalls(t, config.Load(), on, flowReader)
		e := res.Edges[0]
		if len(res.Edges) != 1 || e.P90Ms != 1500 || e.ClientP90Ms != 4750 || e.ConnectionType != "" {
			t.Fatalf("namespaced %v: %s", namespaced, raw)
		}
		if st := res.Sources[0].ClientP90; st == nil || !st.Read || st.Series != 1 || st.Reason != "" || st.Truncated {
			t.Fatalf("namespaced %v: %+v", namespaced, st)
		}
		if len(res.TimeOutsideCallee) != 1 || res.TimeOutsideCallee[0] != (callgraph.Outside{From: "Deployment/shop/web", To: "Deployment/shop/api", ClientP90Ms: 4750, P90Ms: 1500, OutsideMs: 3250}) {
			t.Fatalf("namespaced %v: %+v", namespaced, res.TimeOutsideCallee)
		}
		if on.reads != off.reads+1 || on.count(callgraph.ClientSeconds) != 1 || !strings.HasPrefix(traceQueries(on), before.queries+"\n") {
			t.Fatalf("namespaced %v: %d reads, %d before:\n%s", namespaced, on.reads, off.reads, traceQueries(on))
		}
		// the answer without what it adds is the one before
		res.TimeOutsideCallee, res.Sources[0].ClientP90, res.Edges[0].ClientP90Ms = nil, nil, 0
		if rest, _ := json.Marshal(res); string(rest) != before.answer {
			t.Fatalf("namespaced %v: the rest changed:\n%s\nwant\n%s", namespaced, rest, before.answer)
		}
	}
}

// A Prometheus without the client histogram says "not available" on the traces source, a read that failed says why, and
// with no call counted it is not asked; the traces and the answer are as before in each.
func TestResourceGraphCallsWithoutTheClientHistogram(t *testing.T) {
	for name, c := range map[string]struct {
		src    *clientCalls
		reason string
		detail string
		asked  int
	}{
		"no such metric": {newClientCalls(true, nil), callgraph.ReasonNoMetrics, "not available: this Prometheus has no " + callgraph.ClientSeconds, 1},
		"failed":         {&clientCalls{fakeCalls: newClientCalls(true, nil).fakeCalls, err: errors.New("query timed out")}, callgraph.ReasonFailed, "query timed out", 1},
		"no calls":       {&clientCalls{fakeCalls: newClientCalls(true, nil).fakeCalls, quiet: true}, callgraph.ReasonNoCalls, "", 0},
	} {
		res, raw := readCalls(t, clientOn, c.src, flowReader)
		st := res.Sources[0].ClientP90
		if st == nil || st.Read || st.Reason != c.reason || !strings.HasPrefix(st.Detail, c.detail) || st.Series != 0 {
			t.Errorf("%s: %+v", name, st)
		}
		if !res.Sources[0].Read || res.Sources[0].Reason != "" || c.src.count(callgraph.ClientSeconds) != c.asked {
			t.Errorf("%s: the traces %+v, asked %d", name, res.Sources[0], c.src.count(callgraph.ClientSeconds))
		}
		if strings.Contains(raw, "client_p90_ms\":") || strings.Contains(raw, "time_outside_callee") {
			t.Errorf("%s: %s", name, raw)
		}
		res.Sources[0].ClientP90 = nil
		if rest, _ := json.Marshal(res); name != "no calls" && string(rest) != callsBefore[true].answer {
			t.Errorf("%s: the rest changed:\n%s", name, rest)
		}
	}
}

// Who may read the client side is who reads the traces: a grant limited to namespaces gets neither, a reader without
// resource.networkflow.read both. A side that is no end of a traced call says so.
func TestResourceGraphCallsClientSideKeepsToTheGrant(t *testing.T) {
	scoped := flowReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	src := newClientCalls(true, clientSide(4, ""))
	res, raw := readCalls(t, clientOn, src, scoped)
	if res.Sources[0].Read || res.Sources[0].Reason != callgraph.ReasonNamespaceLimited || res.Sources[0].ClientP90 != nil || src.count("traces_service_graph") != 0 {
		t.Fatalf("scoped: %s, queries %v", raw, src.queries)
	}
	podsOnly := auth.TokenPayload{UserID: "u2", Email: "pods@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read", "resource.objects.read"}}}
	src = newClientCalls(true, clientSide(4, "database"))
	res, raw = readCalls(t, clientOn, src, podsOnly)
	if res.Sources[1].Reason != callgraph.ReasonPermission || !res.Sources[0].ClientP90.Read || res.Edges[0].ClientP90Ms != 4000 ||
		res.Edges[0].ConnectionType != "database" || res.TimeOutsideCallee != nil {
		t.Fatalf("pods only: %s", raw)
	}
}

// A fixed window reads the client side at its end, over its length, as the rest.
func TestResourceGraphCallsClientSideOverAFixedWindow(t *testing.T) {
	client := newClientCalls(true, clientSide(4, ""))
	src := &fixedClient{clientCalls: client}
	h := &Handler{netdropsSrc: src, cfg: clientOn}
	end := time.Date(2026, 11, 15, 1, 0, 0, 0, time.UTC)
	res, err := h.callsIn(logSearchRequestAs("/", "self", "shop", flowReader), "shop", callsGraph, promWindow{Range: 30 * time.Minute, End: end}, src, true)
	if err != nil || !res.Sources[0].ClientP90.Read || res.Edges[0].ClientP90Ms != 4000 {
		t.Fatalf("%+v %v", res, err)
	}
	for _, at := range src.at {
		if !at.Equal(end) {
			t.Fatalf("read at %s", at)
		}
	}
	if client.count(callgraph.ClientSeconds) != 1 || len(src.at) != len(client.queries) || !strings.Contains(traceQueries(client), callgraph.ClientSeconds+`{server_k8s_namespace_name="shop"}[1800s]`) {
		t.Fatalf("%v at %v", client.queries, src.at)
	}
}

type fixedClient struct {
	*clientCalls
	at []time.Time
}

func (f *fixedClient) PrometheusQueryAt(ctx context.Context, q string, at time.Time) ([]k8s.PrometheusQueryResult, error) {
	f.at = append(f.at, at)
	return f.clientCalls.PrometheusQuery(ctx, q)
}

func (f *fixedClient) PrometheusLabelsBetween(ctx context.Context, label, selector string, start, end time.Time, limit int) ([]string, error) {
	return f.clientCalls.PrometheusLabels(ctx, label, selector, end.Sub(start), limit)
}

// The most one answer reads (Hubble metrics that name pods only take one read more): nine with clientLatency off, ten
// with it on, under the twelve a narrowing may make.
func TestResourceGraphCallsMostReads(t *testing.T) {
	podsOnlyShape := []string{"__name__", "source_namespace", "source_pod", "destination_namespace", "destination_pod", "traffic_direction", "reason"}
	for latency, want := range map[bool]int{false: 9, true: 10} {
		src := newClientCalls(true, clientSide(4, ""))
		src.labels[nettraffic.TCPMetric], src.labels[netdrops.Metric] = retinaTCPShape, podsOnlyShape
		readCalls(t, config.Config{CallGraphEnabled: true, CallGraphClientLatency: latency}, src, flowReader)
		if src.reads != want || src.reads > 12 {
			t.Errorf("clientLatency %v: %d reads, want %d:\n%s", latency, src.reads, want, strings.Join(src.queries, "\n"))
		}
	}
}

// The narrowing's call order never reads the client side: with it on, anomaly_rank makes the same store queries and
// answers the same, when the stores take all twelve and when the checks leave the call order room for more.
func TestAnomaliesCallOrderDoesNotReadTheClientSide(t *testing.T) {
	f, src, calls := threeStores(t, clientOn)
	res := f.get(t, "shop", flowReader)
	metrics, logs, spans, order := storeReadsOf(f, src, calls)
	if metrics != 3 || logs != 3 || spans != 3 || order != 3 || res.StoreQueries != 12 || calls.count(callgraph.ClientSeconds) != 0 {
		t.Fatalf("read %d metric, %d log, %d trace and %d call graph queries, %d counted, client side %d", metrics, logs, spans, order, res.StoreQueries, calls.count(callgraph.ClientSeconds))
	}
	var answers []string
	for _, cfg := range []config.Config{{CallGraphEnabled: true}, clientOn} {
		h, _, calls, _ := callOrderHandler(cfg)
		w, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
		if calls.count(callgraph.ClientSeconds) != 0 || res.StoreQueries != 3+len(calls.at)+len(calls.between) || res.StoreQueries >= 12 {
			t.Errorf("client side read %d times, %d store queries: %v", calls.count(callgraph.ClientSeconds), res.StoreQueries, calls.queries)
		}
		answers = append(answers, w.Body.String())
	}
	if answers[0] != answers[1] {
		t.Fatalf("with the client side off and on:\n%s\n%s", answers[0], answers[1])
	}
}
