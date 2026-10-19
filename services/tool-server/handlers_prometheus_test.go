package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPrometheusMetrics_ForwardsAndHints(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"total":3,"truncated":true,"metrics":[{"name":"container_cpu_usage_seconds_total","type":"counter","help":"cpu"}]}`
	})
	out, err := handlePrometheusMetrics(ctxFor("c1"), map[string]interface{}{"pattern": " cpu ", "limit": 999}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/prometheus/metrics" || q.Get("cluster") != "c1" || q.Get("pattern") != "cpu" || q.Get("limit") != "200" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	if m["total"] != float64(3) || m["truncated"] != true || !strings.Contains(m["hint"].(string), "Only 1 of 3") {
		t.Fatalf("result: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":true,"total":0,"metrics":[]}` })
	out, _ = handlePrometheusMetrics(ctxFor("c1"), map[string]interface{}{"pattern": "nope"}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "No metric name contains") {
		t.Fatalf("empty: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"available":false}` })
	out, _ = handlePrometheusMetrics(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "get_pod_metrics") {
		t.Fatalf("no Prometheus: %s", out)
	}
}

func TestPrometheusLabels_NamesValuesAndCut(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		if r.URL.Query().Get("label") == "namespace" {
			return 200, `{"available":true,"label":"namespace","values":["kube-system","shop"],"truncated":true,"since":"1h0m0s"}`
		}
		return 200, `{"available":true,"names":[],"since":"6h0m0s"}`
	})
	out, err := handlePrometheusLabels(ctxFor("c1"), map[string]interface{}{"label": "namespace", "selector": `up{job="kubelet"}`}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/prometheus/labels" || q.Get("selector") != `up{job="kubelet"}` || q.Get("limit") != "200" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	if len(m["values"].([]interface{})) != 2 || m["truncated"] != true || m["names"] != nil {
		t.Fatalf("values: %s", out)
	}
	out, _ = handlePrometheusLabels(ctxFor("c1"), map[string]interface{}{"selector": "x", "since": "6h"}, bearer())
	if m := decode(t, out); m["since"] != "6h0m0s" || !strings.Contains(m["hint"].(string), "Nothing matched") {
		t.Fatalf("empty names: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 400, `{"detail":"bad series selector: \"sum(up)\" is an expression, not a series selector"}`
	})
	if _, err := handlePrometheusLabels(ctxFor("c1"), map[string]interface{}{"selector": "sum(up)"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("an expression selector is the caller's error: %v", err)
	}
}

func TestPrometheusRules_FilterTrimAndScope(t *testing.T) {
	long := strings.Repeat("x", 400)
	var alerts []string
	for i := 0; i < 15; i++ {
		alerts = append(alerts, fmt.Sprintf(`{"labels":{"pod":"p%d"},"state":"firing"}`, i))
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"shared":true,"rules":[
			{"name":"KubePodCrashLooping","type":"alerting","state":"firing","annotations":{"description":"` + long + `"},"alerts":[` + strings.Join(alerts, ",") + `]},
			{"name":"NodeDown","type":"alerting","state":"inactive"},
			{"name":"job:up:sum","type":"recording"}]}`
	})
	out, err := handlePrometheusRules(ctxFor("c1"), map[string]interface{}{"rule": "Crash", "rule_type": "alert", "active_only": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/prometheus/rules" || q.Get("rule") != "Crash" || q.Get("type") != "alert" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	rules := m["rules"].([]interface{})
	if len(rules) != 1 || m["rules_total"] != float64(3) || !strings.HasPrefix(m["scope"].(string), "shared store") {
		t.Fatalf("active only, shared note: %s", out)
	}
	crash := rules[0].(map[string]interface{})
	if len(crash["alerts"].([]interface{})) != promRuleAlertsCap || crash["alerts_total"] != float64(15) {
		t.Fatalf("alerts capped: %v", crash["alerts_total"])
	}
	if d := crash["annotations"].(map[string]interface{})["description"].(string); len(d) > promAnnotationCap+4 || !strings.HasSuffix(d, "…") {
		t.Fatalf("annotation trimmed: %d", len(d))
	}
	if states := m["states"].(map[string]interface{}); states["firing"] != float64(1) || states["inactive"] != float64(1) {
		t.Fatalf("states counted over every rule: %v", states)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"not served by this metrics store: /api/v1/rules"}`
	})
	out, err = handlePrometheusRules(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "ALERTS") {
		t.Fatalf("a store without rules: %v %s", err, out)
	}
}

func TestPrometheusTargets_DownFirstFiltersAndSource(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"available":true,"source":"up_metric","targets":[
			{"job":"kubelet","instance":"n1","health":"up"},{"job":"node-exporter","instance":"n1:9100","health":"down"},
			{"job":"kube-state-metrics","instance":"k","health":"up"}]}`
	})
	out, err := handlePrometheusTargets(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	targets := m["targets"].([]interface{})
	if targets[0].(map[string]interface{})["health"] != "down" || m["health"].(map[string]interface{})["up"] != float64(2) || m["note"] == nil {
		t.Fatalf("down first, counts, up note: %s", out)
	}
	out, _ = handlePrometheusTargets(ctxFor("c1"), map[string]interface{}{"health": "up", "job": "KUBE"}, bearer())
	if got := decode(t, out)["targets"].([]interface{}); len(got) != 2 {
		t.Fatalf("health and job filters: %s", out)
	}
}

func TestPrometheusQuery_AbsoluteWindowAndCutHint(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		var series []string
		for i := 0; i < 150; i++ {
			series = append(series, `{"metric":{"pod":"p`+fmt.Sprint(i)+`"},"points":[{"t":1,"v":1}]}`)
		}
		return 200, `{"available":true,"results":[` + strings.Join(series, ",") + `]}`
	})
	out, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{
		"promql": "up", "since_time": "2026-10-18T00:00:00Z", "until_time": "2026-10-18T06:00:00Z"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/prometheus/query_range" || q.Get("start") != "1792281600" || q.Get("end") != "1792303200" || q.Get("step") != "180" {
		t.Fatalf("absolute range: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	if m["start"] != "2026-10-18T00:00:00Z" || m["truncated"] != true || !strings.Contains(m["hint"].(string), "do not answer from it") {
		t.Fatalf("result: start=%v truncated=%v", m["start"], m["truncated"])
	}
	if _, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "since_time": "8d"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("more than 7 days: %v", err)
	}
	if _, err := handlePrometheusQuery(ctxFor("c1"), map[string]interface{}{"promql": "up", "since_time": "2026-10-18T06:00:00Z", "until_time": "2026-10-18T00:00:00Z"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("start after end: %v", err)
	}
}

func TestPromWindow(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	start, end, err := promWindow("", "2d", "", now)
	if err != nil || end != now || now.Sub(start) != 48*time.Hour {
		t.Fatalf("2d back: %v %v %v", start, end, err)
	}
	start, _, _ = promWindow("30m", "", "", now)
	if now.Sub(start) != 30*time.Minute {
		t.Fatalf("since: %v", start)
	}
	start, _, _ = promWindow("", "", "", now)
	if now.Sub(start) != time.Hour {
		t.Fatalf("default 1h: %v", start)
	}
}

func TestPrometheusDiscoveryArgsAndScope(t *testing.T) {
	for _, bad := range []map[string]interface{}{
		{"label": "1abc"}, {"label": `ns"}`}, {"rule_type": "alerts"}, {"health": "sick"}, {"selector": "up\nx"},
	} {
		if err := validateToolArgs(bad); err == nil {
			t.Fatalf("%v must be refused", bad)
		}
	}
	for _, good := range []map[string]interface{}{
		{"label": "k8s_node_name"}, {"label": "k8s.node.name"}, {"rule_type": "record"}, {"health": "down"},
		{"selector": `container_cpu_usage_seconds_total{namespace="shop"}`}, {"rule": "Kube Pod Crash"},
	} {
		if err := validateToolArgs(good); err != nil {
			t.Fatalf("%v: %v", good, err)
		}
	}
	for _, tool := range []string{"prometheus_metrics", "prometheus_labels", "prometheus_rules", "prometheus_targets"} {
		if _, ok := clusterWideTools[tool]; !ok {
			t.Fatalf("%s spans the cluster: a namespace-scoped grant must not reach it", tool)
		}
	}
}
