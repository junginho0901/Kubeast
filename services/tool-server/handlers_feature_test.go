package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeK8sService stands in for k8s-service: it records the request and answers as scripted.
func fakeK8sService(t *testing.T, respond func(r *http.Request) (int, string)) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		status, body := respond(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	orig := k8sServiceURL
	k8sServiceURL = srv.URL
	t.Cleanup(func() { k8sServiceURL = orig; srv.Close() })
	return &seen
}

func ctxFor(cluster string, namespaces ...string) context.Context {
	ctx := withClusterID(context.Background(), cluster)
	if len(namespaces) > 0 {
		ctx = auth.WithPayload(ctx, auth.TokenPayload{Namespaces: map[string][]string{cluster: namespaces}})
	}
	return ctx
}

func bearer() http.Header { return http.Header{"Authorization": {"Bearer user-token"}} }

func TestPrometheusQuery_InstantPassesTokenAndCluster(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[{"metric":{"pod":"web-1"},"value":[1700000000,"0.5"]}]}`
	})
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": `sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)`}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	if r.URL.Path != "/api/v1/prometheus/query" || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s auth=%q", r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
	}
	if !strings.Contains(r.URL.Query().Get("query"), "container_cpu_usage_seconds_total") {
		t.Fatalf("query not forwarded: %s", r.URL.RawQuery)
	}
	m := decode(t, out)
	if m["range"] != false || m["series"] != float64(1) || m["truncated"] != nil {
		t.Fatalf("result: %s", out)
	}
}

func TestPrometheusQuery_RangeStepAndThinning(t *testing.T) {
	var points []string
	for i := 0; i < 500; i++ {
		points = append(points, `{"t":`+strconv.Itoa(i)+`,"v":"1"}`)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[{"metric":{},"points":[` + strings.Join(points, ",") + `]}]}`
	})
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "range": true, "since": "2h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/prometheus/query_range" || q.Get("step") != "60" || q.Get("start") == "" || q.Get("end") == "" {
		t.Fatalf("range request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	pts := m["results"].([]interface{})[0].(map[string]interface{})["points"].([]interface{})
	if len(pts) != promPointsCap || m["truncated"] != true || m["step_seconds"] != float64(60) {
		t.Fatalf("thinned to %d points, truncated=%v step=%v", len(pts), m["truncated"], m["step_seconds"])
	}
	if last := pts[len(pts)-1].(map[string]interface{})["t"]; last != float64(499) {
		t.Fatalf("the last point is kept: %v", last)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":true,"results":[]}` })
	out, err = handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "range": true, "since": "10m", "step": "5"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["step_seconds"] != float64(promMinStepSecond) || !strings.Contains(m["hint"].(string), "no series") {
		t.Fatalf("minimum step and empty hint: %s", out)
	}
}

func TestPrometheusQuery_UnavailableAndCaps(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":false,"results":[]}` })
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "unavailable" || m["feature"] != "prometheus" || !strings.Contains(m["alternative"].(string), "get_pod_metrics") {
		t.Fatalf("unavailable: %s", out)
	}

	var series []string
	for i := 0; i < promSeriesCap+20; i++ {
		series = append(series, `{"metric":{"i":"`+strconv.Itoa(i)+`"},"value":[1,"1"]}`)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"results":[` + strings.Join(series, ",") + `]}`
	})
	out, err = handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if len(m["results"].([]interface{})) != promSeriesCap || m["series"] != float64(promSeriesCap+20) || m["truncated"] != true {
		t.Fatalf("series cap: %s", out[:200])
	}

	if _, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("promql required: %v", err)
	}
}

func TestLogSearch_ParamsScopeAndRefusals(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"lines":[{"ts":"2026-10-15T00:00:00Z","namespace":"shop","pod":"web-1","container":"app","line":"error one"},{"ts":"2026-10-15T00:00:01Z","namespace":"shop","pod":"web-1","container":"app","line":"error two"}],"limit":100}`
	})
	out, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "text": "error", "workload_kind": "Deployment", "workload_name": "web", "since": "30m", "limit": 1, "regex": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/namespaces/shop/logsearch" || q.Get("q") != "error" || q.Get("workload_kind") != "Deployment" || q.Get("workload_name") != "web" ||
		q.Get("since") != "30m" || q.Get("limit") != "1" || q.Get("ignore_case") != "true" || q.Get("match") != "regex" || q.Get("cluster") != "c1" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	if len(m["lines"].([]interface{})) != 1 || m["truncated"] != true || m["returned"] != float64(2) || m["namespace"] != "shop" {
		t.Fatalf("capped to limit: %s", out)
	}

	seen = fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"lines":[]}` })
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"limit": 9999}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q = (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/logsearch" || q.Get("since") != "1h" || q.Get("limit") != strconv.Itoa(logLinesCap) || q.Get("match") != "" {
		t.Fatalf("defaults and cap: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "Widen since") || m["namespace"] != "all namespaces" {
		t.Fatalf("empty hint: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"log search is not configured for this cluster"}`
	})
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "k8s_get_pod_logs") {
		t.Fatalf("not configured: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 403, `{"detail":"forbidden: the cluster does not let you read pod logs in shop"}`
	})
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "forbidden" || !strings.Contains(m["reason"].(string), "pod logs") {
		t.Fatalf("forbidden: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 429, `{"detail":"too many log searches: 10 per minute"}` })
	out, err = handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil || decode(t, out)["status"] != "rate_limited" {
		t.Fatalf("rate limited: %v %s", err, out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 400, `{"detail":"since must be a positive duration"}` })
	if _, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("400 is the caller's: %v", err)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 502, `{"detail":"loki: connection refused"}` })
	if _, err := handleLogSearch(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer()); err == nil || errors.Is(err, errBadRequest) {
		t.Fatalf("a store failure stays an error: %v", err)
	}
}

func TestIssues_FilterScopeSeverityAndCounts(t *testing.T) {
	body := `{"window_minutes":30,"generated_at":"2026-10-15T00:00:00Z","issues":[
		{"id":"1","kind":"Pod","namespace":"shop","name":"web-1","severity":"critical","reason":"CrashLoopBackOff"},
		{"id":"2","kind":"Deployment","namespace":"db","name":"pg","severity":"warning","reason":"Unavailable"},
		{"id":"3","kind":"Node","name":"n1","severity":"warning","reason":"MemoryPressure"},
		{"id":"4","kind":"Pod","namespace":"shop","name":"api-1","severity":"info","reason":"Restarted"}]}`
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleIssues(ctxFor("c1"), map[string]interface{}{"window_minutes": 45}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Query().Get("window") != "45" || (*seen)[0].URL.Path != "/api/v1/issues" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	counts, _ := json.Marshal(m["counts"])
	if m["total"] != float64(4) || string(counts) != `{"critical":1,"info":1,"warning":2}` || m["namespace"] != "all namespaces" {
		t.Fatalf("whole cluster: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "severity": "critical"}, bearer())
	m = decode(t, out)
	issues := m["issues"].([]interface{})
	if m["total"] != float64(1) || issues[0].(map[string]interface{})["name"] != "web-1" {
		t.Fatalf("namespace + severity: %s", out)
	}

	// A namespace-scoped grant sees only its namespaces; cluster-scoped issues (nodes) drop out.
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleIssues(ctxFor("c1", "shop"), map[string]interface{}{}, bearer())
	m = decode(t, out)
	ns, _ := json.Marshal(m["namespace"])
	if m["total"] != float64(2) || string(ns) != `["shop"]` {
		t.Fatalf("scoped grant: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"window_minutes":30,"issues":[]}` })
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "Nothing is failing") {
		t.Fatalf("empty hint: %s", out)
	}

	var many []string
	for i := 0; i < issuesCap+5; i++ {
		many = append(many, `{"id":"`+strconv.Itoa(i)+`","kind":"Pod","namespace":"shop","name":"p","severity":"warning"}`)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"window_minutes":30,"issues":[` + strings.Join(many, ",") + `]}`
	})
	out, _ = handleIssues(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); len(m["issues"].([]interface{})) != issuesCap || m["truncated"] != true || m["total"] != float64(issuesCap+5) {
		t.Fatalf("cap: total=%v", m["total"])
	}
}

func TestFeatureFailure_Mapping(t *testing.T) {
	if out, ok, _ := featureFailure("x", "alt", 404, []byte(`{"detail":"x is not configured for this cluster"}`)); !ok || decode(t, out)["status"] != "unavailable" {
		t.Fatal("404 not configured → unavailable")
	}
	if _, ok, err := featureFailure("x", "", 404, []byte(`{"detail":"cluster not found"}`)); ok || err == nil {
		t.Fatal("an unknown cluster is an error")
	}
	if _, ok, err := featureFailure("x", "", 400, []byte(`{"detail":"bad since"}`)); ok || !errors.Is(err, errBadRequest) {
		t.Fatal("400 → bad request")
	}
	if detailOf([]byte("plain text")) != "plain text" || detailOf([]byte(`{"error":"e"}`)) != "e" {
		t.Fatal("detailOf")
	}
}

func TestFeatureArgsAndGate(t *testing.T) {
	for _, args := range []map[string]interface{}{{"promql": "up{job=\"x\"} > 1"}, {"text": "connection refused"}, {"severity": "Warning"}, {"workload_kind": "Deployment", "workload_name": "web"}, {"pod": "web-1"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{{"promql": "up\nup"}, {"promql": strings.Repeat("x", 2001)}, {"text": "a\tb"}, {"severity": "high"}, {"workload_kind": "--all"}, {"pod": "-n"}} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "prometheus_query", map[string]interface{}{"promql": "up"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("PromQL spans the cluster: %v", err)
	}
	if err := namespaceGate(scoped, "c", "issues", map[string]interface{}{}); err != nil {
		t.Fatalf("issues scopes itself: %v", err)
	}
	if err := namespaceGate(scoped, "c", "issues", map[string]interface{}{"namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("issues outside the grant: %v", err)
	}
	if err := namespaceGate(scoped, "c", "logsearch", map[string]interface{}{}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("log search needs a namespace from a scoped grant: %v", err)
	}
	_ = url.Values{}
}
