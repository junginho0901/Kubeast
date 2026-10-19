package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLokiQuery_MetricSeriesForTheChart(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"resultType":"matrix","effectiveQuery":"sum(count_over_time({k8s_cluster_name=\"kubeast\", k8s_namespace_name=\"shop\", app=\"web\"}[5m]))","series":[{"metric":{"k8s_pod_name":"web-1"},"points":[{"t":1760443200,"v":3},{"t":1760443500,"v":5}]}]}`
	})
	out, err := handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": ` sum(count_over_time({app="web"}[5m])) `, "namespace": "shop", "since": "2h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	start, _ := time.Parse(time.RFC3339, q.Get("start"))
	end, _ := time.Parse(time.RFC3339, q.Get("end"))
	if r.URL.Path != "/api/v1/namespaces/shop/logsearch/logql" || q.Get("q") != `sum(count_over_time({app="web"}[5m]))` || q.Get("step") != "60" ||
		end.Sub(start) != 2*time.Hour || q.Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	results := m["results"].([]interface{})
	if m["kind"] != "metric" || m["range"] != true || m["series"] != float64(1) || len(results) != 1 || m["step_seconds"] != float64(60) ||
		!strings.Contains(m["effective_query"].(string), `k8s_namespace_name="shop"`) {
		t.Fatalf("result: %s", out)
	}
	if pts := results[0].(map[string]interface{})["points"].([]interface{}); len(pts) != 2 || !strings.Contains(m["note"].(string), "no point") {
		t.Fatalf("points: %s", out)
	}
}

func TestLokiQuery_LinesCutAndEmpty(t *testing.T) {
	lines := make([]string, 120)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"line":"l%d"}`, i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"resultType":"streams","effectiveQuery":"{k8s_cluster_name=\"kubeast\", app=\"web\"}","lines":[` + strings.Join(lines, ",") + `],"oldest":"2026-10-19T00:00:00Z","newest":"2026-10-19T01:00:00Z"}`
	})
	out, err := handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": `{app="web"} |= "err"`, "limit": 50}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/logsearch/logql" || (*seen)[0].URL.Query().Get("limit") != "50" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	if m["kind"] != "log" || m["returned"] != float64(50) || m["truncated"] != true || !strings.Contains(m["hint"].(string), "cut") || m["namespace"] != "all namespaces" {
		t.Fatalf("result: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"resultType":"streams","lines":[]}` })
	out, _ = handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": `{app="nope"}`}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "loki_labels") {
		t.Fatalf("empty: %s", out)
	}
	if _, err := handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": " "}, bearer()); err == nil {
		t.Fatal("an empty query is a bad request")
	}
}

func TestLokiTools_StoreMissingRefusedOrBroken(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{404, `{"detail":"log search is not configured for this cluster"}`, `"unavailable"`},
		{403, `{"detail":"forbidden: the cluster does not let you read pod logs in shop"}`, `"forbidden"`},
		{429, `{"detail":"too many log searches: 20 per minute"}`, `"rate_limited"`},
	}
	for _, c := range cases {
		fakeK8sService(t, func(r *http.Request) (int, string) { return c.status, c.body })
		out, err := handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": `{app="web"}`, "namespace": "shop"}, bearer())
		if err != nil || !strings.Contains(out, c.want) {
			t.Fatalf("%d: %s %v", c.status, out, err)
		}
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 400, `{"detail":"parse error at line 1, col 12"}` })
	if _, err := handleLokiQuery(ctxFor("c1"), map[string]interface{}{"logql": `{app="web"} | nope`}, bearer()); err == nil || !strings.Contains(err.Error(), "parse error") {
		t.Fatalf("a query the store cannot parse: %v", err)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"log patterns not served by this log store (Loki needs pattern_ingester.enabled)"}`
	})
	out, err := handleLokiPatterns(ctxFor("c1"), map[string]interface{}{"selector": `{app="web"}`}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "count_over_time") {
		t.Fatalf("patterns off: %s %v", out, err)
	}
}

func TestLokiLabels_NamesValuesAndCut(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		if r.URL.Query().Get("label") != "" {
			return 200, `{"label":"k8s_pod_name","values":["web-1","web-2"],"truncated":true}`
		}
		return 200, `{"values":[]}`
	})
	out, err := handleLokiLabels(ctxFor("c1"), map[string]interface{}{"label": "k8s_pod_name", "namespace": "shop", "since": "6h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/namespaces/shop/logsearch/labels" || (*seen)[0].URL.Query().Get("label") != "k8s_pod_name" {
		t.Fatalf("request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); m["label"] != "k8s_pod_name" || len(m["values"].([]interface{})) != 2 || m["truncated"] != true || !strings.Contains(m["hint"].(string), "regex") {
		t.Fatalf("values: %s", out)
	}
	out, _ = handleLokiLabels(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); (*seen)[1].URL.Path != "/api/v1/logsearch/labels" || !strings.Contains(m["hint"].(string), "widen") {
		t.Fatalf("names: %s", out)
	}
}

func TestLokiPatterns_TopAndCutText(t *testing.T) {
	long := strings.Repeat("x", 400)
	pats := make([]string, 25)
	for i := range pats {
		pats[i] = fmt.Sprintf(`{"pattern":"<_> level=error %s %d","count":%d}`, long, i, 100-i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"total":25,"effectiveQuery":"{k8s_cluster_name=\"kubeast\", app=\"web\"}","patterns":[` + strings.Join(pats, ",") + `]}`
	})
	out, err := handleLokiPatterns(ctxFor("c1"), map[string]interface{}{"selector": `{app="web"}`, "since": "3h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/logsearch/patterns" || (*seen)[0].URL.Query().Get("q") != `{app="web"}` {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	got := m["patterns"].([]interface{})
	first := got[0].(map[string]interface{})["pattern"].(string)
	if len(got) != lokiPatternsCap || len([]rune(first)) != lokiPatternTextCap+1 || !strings.HasSuffix(first, "…") || !strings.Contains(m["hint"].(string), "20 most frequent of 25") {
		t.Fatalf("result: %d patterns, first %d runes, hint %v", len(got), len([]rune(first)), m["hint"])
	}
	if _, err := handleLokiPatterns(ctxFor("c1"), map[string]interface{}{}, bearer()); err == nil {
		t.Fatal("a selector is required")
	}
}

func TestLokiArgs_Checked(t *testing.T) {
	if err := validateToolArgs(map[string]interface{}{"logql": "{a=\"b\"}\n| json"}); err == nil {
		t.Fatal("a control character in logql passed")
	}
	if err := validateToolArgs(map[string]interface{}{"logql": strings.Repeat("a", 4097)}); err == nil {
		t.Fatal("a 4097-character logql passed")
	}
	if err := validateToolArgs(map[string]interface{}{"label": "a b"}); err == nil {
		t.Fatal("a label with a space passed")
	}
	if err := validateToolArgs(map[string]interface{}{"logql": `sum by (pod) (rate({app="web"} |= "error" [5m]))`, "since": "6h"}); err != nil {
		t.Fatal(err)
	}
}
