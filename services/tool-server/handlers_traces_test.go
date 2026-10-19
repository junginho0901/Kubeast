package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestTracesSearch_ScopedPathCapsAndHints(t *testing.T) {
	spans := make([]string, 8)
	for i := range spans {
		spans[i] = fmt.Sprintf(`{"spanId":"s%d","durationMs":%d}`, i, i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"effectiveQuery":"{ ( status = error ) && resource.k8s.cluster.name = \"kubeast\" }","traces":[{"traceId":"t1","matched":8,"spans":[` + strings.Join(spans, ",") + `]}]}`
	})
	out, err := handleTracesSearch(ctxFor("c1"), map[string]interface{}{"traceql": " { status = error } ", "namespace": "shop", "limit": 500, "since": "30m"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/namespaces/shop/traces/search" || q.Get("q") != "{ status = error }" || q.Get("limit") != "20" || q.Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	tr := m["traces"].([]interface{})[0].(map[string]interface{})
	if m["returned"] != float64(1) || len(tr["spans"].([]interface{})) != matchedSpansCap || !strings.Contains(m["effective_query"].(string), "kubeast") {
		t.Fatalf("result: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"traces":[]}` })
	out, _ = handleTracesSearch(ctxFor("c1"), map[string]interface{}{"traceql": "{}"}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "traces_tags") {
		t.Fatalf("empty: %s", out)
	}
	if _, err := handleTracesSearch(ctxFor("c1"), map[string]interface{}{}, bearer()); err == nil {
		t.Fatal("a missing traceql is a bad request")
	}
}

func TestTracesGet_HiddenSpansAndCut(t *testing.T) {
	spans := make([]string, 120)
	for i := range spans {
		spans[i] = fmt.Sprintf(`{"spanId":"%016x","name":"op"}`, i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","total":130,"hidden":10,"errors":2,"spans":[` + strings.Join(spans, ",") + `]}`
	})
	out, err := handleTracesGet(ctxFor("c1"), map[string]interface{}{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/traces/trace/4bf92f3577b34da6a3ce929d0e0e4736" || (*seen)[0].URL.Query().Get("start") != "" {
		t.Fatalf("request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	if m["shown"] != float64(traceSpansCap) || m["hidden"] != float64(10) || m["truncated"] != true || !strings.Contains(m["note"].(string), "10 of 130") {
		t.Fatalf("result: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"trace not found"}` })
	out, err = handleTracesGet(ctxFor("c1"), map[string]interface{}{"trace_id": "4bf92f3577b34da6"}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "not_found" {
		t.Fatalf("not found: %s %v", out, err)
	}
}

func TestTracesMetrics_RangeShapeForTheChart(t *testing.T) {
	pts := make([]string, 300)
	for i := range pts {
		pts[i] = fmt.Sprintf(`{"t":%d,"v":%d}`, 1760443200+i*15, i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"effectiveQuery":"x","series":[{"metric":{"resource.service.name":"cart"},"points":[` + strings.Join(pts, ",") + `]}]}`
	})
	out, err := handleTracesMetrics(ctxFor("c1"), map[string]interface{}{"traceql": `{ status = error } | rate() by (resource.service.name)`, "since": "2h"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/traces/metrics" || (*seen)[0].URL.Query().Get("step") != "60" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	res := m["results"].([]interface{})[0].(map[string]interface{})
	if m["range"] != true || m["kind"] != "metric" || len(res["points"].([]interface{})) != promPointsCap || m["truncated"] != true {
		t.Fatalf("result: %d points, %s", len(res["points"].([]interface{})), m["hint"])
	}
	// the store's end cutoff: points that stop well before the window's end are said, points up to it are not
	for gap, said := range map[int64]bool{300: true, 40: false} {
		last := time.Now().Unix() - gap
		fakeK8sService(t, func(r *http.Request) (int, string) {
			return 200, fmt.Sprintf(`{"series":[{"metric":{},"points":[{"t":%d,"v":1},{"t":%d,"v":2}]}]}`, last-15, last)
		})
		out, _ = handleTracesMetrics(ctxFor("c1"), map[string]interface{}{"traceql": `{} | count_over_time()`, "since": "30m"}, bearer())
		note, _ := decode(t, out)["note"].(string)
		if strings.Contains(note, "traces_search") != said {
			t.Fatalf("gap %ds: note %q", gap, note)
		}
	}
}

func TestTracesTagsAndCompare(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/traces/compare") {
			return 200, `{"traces":10,"p50Ms":500,"slowest":[{"traceId":"t10","durationMs":1000,"spans":[{"spanId":"a"},{"spanId":"b"},{"spanId":"c"}]}],"fastest":[],"typical":[]}`
		}
		return 200, `{"tag":"resource.service.name","values":[]}`
	})
	out, err := handleTracesTags(ctxFor("c1"), map[string]interface{}{"tag": "resource.service.name", "namespace": "shop"}, bearer())
	if err != nil || (*seen)[0].URL.Path != "/api/v1/namespaces/shop/traces/tags" || (*seen)[0].URL.Query().Get("tag") != "resource.service.name" {
		t.Fatalf("tags: %v %s", err, (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "widen") {
		t.Fatalf("tags: %s", out)
	}
	out, err = handleTracesCompare(ctxFor("c1"), map[string]interface{}{"traceql": `{ kind = server }`, "limit": 50}, bearer())
	if err != nil || (*seen)[1].URL.Query().Get("limit") != "50" {
		t.Fatalf("compare: %v", err)
	}
	m := decode(t, out)
	slow := m["slowest"].([]interface{})[0].(map[string]interface{})
	if len(slow["spans"].([]interface{})) != 2 || !strings.Contains(m["note"].(string), "traces_get") {
		t.Fatalf("compare: %s", out)
	}
}

func TestTraces_RefusedQueryAndMissingStore(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 400, `{"detail":"invalid TraceQL: \"rootServiceName\" reads spans outside your scope (the root span, the parent or tree positions)"}`
	})
	if _, err := handleTracesSearch(ctxFor("c1"), map[string]interface{}{"traceql": `{ rootServiceName = "gw" }`}, bearer()); err == nil || !strings.Contains(err.Error(), "Filter on the spans themselves") {
		t.Fatalf("refused query: %v", err)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"trace store is not configured for this cluster"}`
	})
	out, err := handleTracesSearch(ctxFor("c1"), map[string]interface{}{"traceql": `{}`}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "loki_query") {
		t.Fatalf("missing store: %s %v", out, err)
	}
	for args, ok := range map[string]bool{"4bf92f3577b34da6": true, "c536060df7a6cb71dd28c7fb0886d34": true, "xyz": false, "4bf92f3577b34da6a3ce929d0e0e47360": false} {
		if err := validateToolArgs(map[string]interface{}{"trace_id": args}); (err == nil) != ok {
			t.Fatalf("trace_id %q: %v", args, err)
		}
	}
	if err := validateToolArgs(map[string]interface{}{"scope": "parent"}); err == nil {
		t.Fatal("scope parent passed")
	}
	if err := validateToolArgs(map[string]interface{}{"traceql": "{}\n"}); err == nil {
		t.Fatal("a control character in traceql passed")
	}
}
