package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/traces"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A fixture whose trace store is an httptest Tempo; requests are recorded.
type traceFixture struct {
	h        *Handler
	store    *memAudit
	requests []*http.Request
	reviews  []string
}

func newTraceFixture(t *testing.T, tempo http.HandlerFunc) *traceFixture {
	t.Helper()
	f := &traceFixture{store: &memAudit{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests = append(f.requests, r)
		tempo(w, r)
	}))
	t.Cleanup(srv.Close)
	s, err := traces.New(traces.Config{
		Enabled: true, URL: srv.URL + "/api/datasources/proxy/uid/tempo", Tenant: "team-a",
		ClusterAttribute: "k8s.cluster.name", NamespaceAttribute: "k8s.namespace.name",
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxTraces: 20, Timeout: 500 * time.Millisecond, PerUserPerMinute: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store}
	f.h.SetTraceStore(s)
	f.h.logSearchCanI = func(_ context.Context, ns string) (bool, error) {
		f.reviews = append(f.reviews, ns)
		return ns != "secret-team", nil
	}
	return f
}

func (f *traceFixture) serve(handler func(http.ResponseWriter, *http.Request), r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func traceTarget(path, q string) string {
	if q == "" {
		return path
	}
	return path + "?q=" + url.QueryEscape(q)
}

func (f *traceFixture) lastRow(t *testing.T) (audit.Record, map[string]interface{}) {
	t.Helper()
	if len(f.store.rows) == 0 {
		t.Fatal("no audit row")
	}
	row := f.store.rows[len(f.store.rows)-1]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	return row, after
}

const scopeNS = `resource.k8s.cluster.name = "kubeast" && resource.k8s.namespace.name = "shop"`

func TestTraceSearchAddsTheScopeAndLeavesTheRootOut(t *testing.T) {
	f := newTraceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"traces":[{"traceID":"f92f3577b34da6a3ce929d0e0e4736","rootServiceName":"prod-gateway","rootTraceName":"GET /","durationMs":9000,
			"spanSets":[{"matched":2,"spans":[{"spanID":"f067aa0ba902b7","name":"GET /cart","startTimeUnixNano":"1760443200000000000","durationNanos":"1500000000",
			"attributes":[{"key":"http.route","value":{"stringValue":"/cart"}},{"key":"http.status_code","value":{"intValue":"500"}}]}]}]}]}`))
	})
	raw := `{ status = error } >> { span.http.route = "/cart" }`
	w := f.serve(f.h.TraceSearchNamespace, logSearchRequestAs(traceTarget("/api/v1/namespaces/shop/traces/search", raw)+"&since=30m&limit=999", "self", "shop", podReader))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	want := `{ ( status = error ) && ` + scopeNS + ` } >> { ( span.http.route = "/cart" ) && ` + scopeNS + ` }`
	r := f.requests[0]
	if r.URL.Path != "/api/datasources/proxy/uid/tempo/api/search" || r.URL.Query().Get("q") != want || r.URL.Query().Get("limit") != "20" ||
		r.Header.Get("X-Scope-OrgID") != "team-a" || f.reviews[0] != "shop" {
		t.Fatalf("request %s %v reviews %v", r.URL.Path, r.URL.Query(), f.reviews)
	}
	if strings.Contains(w.Body.String(), "prod-gateway") || strings.Contains(w.Body.String(), "9000") {
		t.Fatalf("trace-level fields reached the caller: %s", w.Body)
	}
	var res traces.SearchResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	sp := res.Traces[0].Spans[0]
	// Tempo writes IDs without their leading zeros: they come back whole, for traces_get
	if res.Traces[0].TraceID != "00f92f3577b34da6a3ce929d0e0e4736" || sp.SpanID != "00f067aa0ba902b7" {
		t.Fatalf("IDs %s %s", res.Traces[0].TraceID, sp.SpanID)
	}
	if res.EffectiveQuery != want || res.Traces[0].Matched != 2 || sp.DurationMs != 1500 || sp.Attributes["http.status_code"] != "500" || sp.Start.Unix() != 1760443200 {
		t.Fatalf("result %+v", res)
	}
	row, after := f.lastRow(t)
	if row.Action != "k8s.traces.query" || row.Result == audit.ResultFailure || row.Namespace != "shop" || after["kind"] != "search" ||
		after["traceql"] != raw || after["effective"] != want || after["traces"] != float64(1) || after["range_seconds"] != float64(1800) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "/cart\"}") || strings.Contains(string(row.After), "GET /cart") {
		t.Fatal("the audit row carries span contents")
	}
}

func TestTraceGetKeepsOnlyTheScopesSpans(t *testing.T) {
	trace := `{"trace":{"resourceSpans":[
		{"resource":{"attributes":[{"key":"k8s.cluster.name","value":{"stringValue":"kubeast"}},{"key":"k8s.namespace.name","value":{"stringValue":"shop"}},{"key":"service.name","value":{"stringValue":"cart"}}]},
		 "scopeSpans":[{"spans":[{"spanId":"APBnqgupArc=","parentSpanId":"","name":"GET /cart","kind":"SPAN_KIND_SERVER","startTimeUnixNano":"1760443200000000000","endTimeUnixNano":"1760443200250000000","status":{}},
		                          {"spanId":"AAAAAAAAAAE=","name":"SELECT","startTimeUnixNano":"1760443200100000000","endTimeUnixNano":"1760443200200000000","status":{"code":"STATUS_CODE_ERROR","message":"timeout"}}]}]},
		{"resource":{"attributes":[{"key":"k8s.cluster.name","value":{"stringValue":"kubeast"}},{"key":"k8s.namespace.name","value":{"stringValue":"billing"}}]},
		 "scopeSpans":[{"spans":[{"spanId":"AAAAAAAAAAI=","name":"charge","startTimeUnixNano":"1","endTimeUnixNano":"2"}]}]},
		{"resource":{"attributes":[{"key":"k8s.cluster.name","value":{"stringValue":"prod"}}]},
		 "scopeSpans":[{"spans":[{"spanId":"AAAAAAAAAAM=","name":"gateway","startTimeUnixNano":"1","endTimeUnixNano":"2"}]}]}]}}`
	f := newTraceFixture(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(trace)) })
	id := "BF92F3577B34DA6A3CE929D0E0E4736" // as Tempo's search writes it: no leading zero
	w := f.serve(f.h.TraceGetNamespace, withTraceID(logSearchRequestAs("/api/v1/namespaces/shop/traces/trace/"+id, "self", "shop", podReader), id))
	var res traces.TraceResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || len(res.Spans) != 2 || res.Hidden != 2 || res.Total != 4 || res.Errors != 1 {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	if res.Spans[0].Name != "SELECT" || res.Spans[0].Message != "timeout" || res.Spans[1].SpanID != "00f067aa0ba902b7" || res.Spans[1].Service != "cart" ||
		res.Spans[1].DurationMs != 250 || res.Spans[1].Kind != "SERVER" || strings.Contains(w.Body.String(), "gateway") || strings.Contains(w.Body.String(), "charge") {
		t.Fatalf("spans %+v", res.Spans)
	}
	if p := f.requests[0].URL.Path; p != "/api/datasources/proxy/uid/tempo/api/v2/traces/0bf92f3577b34da6a3ce929d0e0e4736" || res.TraceID != "0bf92f3577b34da6a3ce929d0e0e4736" || f.requests[0].URL.Query().Get("start") != "" {
		t.Fatalf("request %s %v", p, f.requests[0].URL.Query())
	}
	if _, after := f.lastRow(t); after["kind"] != "trace" || after["spans"] != float64(2) || after["hidden"] != float64(2) {
		t.Fatalf("after %v", after)
	}

	// every namespace (unscoped grant): billing's span comes too, prod's never
	w = f.serve(f.h.TraceGetAll, withTraceID(logSearchRequestAs("/api/v1/traces/trace/"+id, "self", "", podReader), id))
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if len(res.Spans) != 3 || res.Hidden != 1 || strings.Contains(w.Body.String(), "gateway") {
		t.Fatalf("every namespace: %s", w.Body)
	}

	// a trace with no span in the scope reads as not found
	other := newTraceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"trace":{"resourceSpans":[{"resource":{"attributes":[{"key":"k8s.cluster.name","value":{"stringValue":"prod"}}]},"scopeSpans":[{"spans":[{"spanId":"AAAAAAAAAAM=","name":"x"}]}]}]}}`))
	})
	w = other.serve(other.h.TraceGetAll, withTraceID(logSearchRequestAs("/api/v1/traces/trace/"+id, "self", "", podReader), id))
	if w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), `"x"`) {
		t.Fatalf("foreign trace: %d %s", w.Code, w.Body)
	}
}

func TestTraceMetricsTagsAndCompare(t *testing.T) {
	f := newTraceFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/metrics/query_range"):
			_, _ = w.Write([]byte(`{"series":[{"labels":[{"key":"resource.service.name","value":{"stringValue":"cart"}}],"samples":[{"timestampMs":"1760443260000","value":2},{"timestampMs":"1760443200000","value":1.5}]}]}`))
		case strings.HasSuffix(r.URL.Path, "/api/v2/search/tags"):
			_, _ = w.Write([]byte(`{"scopes":[{"name":"span","tags":["http.route","db.system"]},{"name":"resource","tags":["service.name"]},{"name":"intrinsic","tags":["duration","rootServiceName","status","trace:duration","trace:id"]}]}`))
		case strings.Contains(r.URL.Path, "/api/v2/search/tag/"):
			_, _ = w.Write([]byte(`{"tagValues":[{"type":"string","value":"payments"},{"type":"string","value":"cart"}]}`))
		case strings.HasSuffix(r.URL.Path, "/api/search"):
			var b strings.Builder
			b.WriteString(`{"traces":[`)
			for i := 1; i <= 10; i++ {
				if i > 1 {
					b.WriteString(",")
				}
				fmt.Fprintf(&b, `{"traceID":"t%02d","spanSets":[{"matched":1,"spans":[{"spanID":"s","durationNanos":"%d000000"}]}]}`, i, i*100)
			}
			b.WriteString(`]}`)
			_, _ = w.Write([]byte(b.String()))
		}
	})
	q := `{ status = error } | rate() by (resource.service.name)`
	w := f.serve(f.h.TraceMetricsAll, logSearchRequestAs(traceTarget("/api/v1/traces/metrics", q)+"&since=2h&step=60", "self", "", podReader))
	var m traces.MetricsResult
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	if w.Code != http.StatusOK || len(m.Series) != 1 || m.Series[0].Metric["resource.service.name"] != "cart" || m.Series[0].Points[0] != (traces.Point{T: 1760443200, V: 1.5}) ||
		f.requests[0].URL.Query().Get("step") != "60s" || !strings.Contains(f.requests[0].URL.Query().Get("q"), `resource.k8s.cluster.name = "kubeast" } | rate()`) {
		t.Fatalf("metrics %d %s %v", w.Code, w.Body, f.requests[0].URL.Query())
	}

	w = f.serve(f.h.TraceTagsNamespace, logSearchRequestAs("/api/v1/namespaces/shop/traces/tags?scope=span", "self", "shop", podReader))
	var tg traces.TagsResult
	_ = json.Unmarshal(w.Body.Bytes(), &tg)
	r := f.requests[1]
	if w.Code != http.StatusOK || strings.Join(tg.Scopes["span"], ",") != "db.system,http.route" || strings.Join(tg.Scopes["intrinsic"], ",") != "duration,status,trace:id" ||
		r.URL.Query().Get("scope") != "span" || r.URL.Query().Get("q") != `{ `+scopeNS+` }` {
		t.Fatalf("tags %d %s %v", w.Code, w.Body, r.URL.Query())
	}
	w = f.serve(f.h.TraceTagsAll, logSearchRequestAs("/api/v1/traces/tags?tag=resource.service.name", "self", "", podReader))
	_ = json.Unmarshal(w.Body.Bytes(), &tg)
	if w.Code != http.StatusOK || strings.Join(tg.Values, ",") != "cart,payments" || f.requests[2].URL.Path != "/api/datasources/proxy/uid/tempo/api/v2/search/tag/resource.service.name/values" {
		t.Fatalf("values %d %s %s", w.Code, w.Body, f.requests[2].URL.Path)
	}
	auditedBefore := len(f.store.rows)
	if auditedBefore != 1 {
		t.Fatalf("only the metrics read is audited, tags are not: %d rows", auditedBefore)
	}

	// compare ranks the sample by its slowest matched span: min 100, p50 500, p90 900, max 1000
	w = f.serve(f.h.TraceCompareAll, logSearchRequestAs(traceTarget("/api/v1/traces/compare", `{ span.http.route = "/cart" }`)+"&per_group=2", "self", "", podReader))
	var c traces.CompareResult
	_ = json.Unmarshal(w.Body.Bytes(), &c)
	if w.Code != http.StatusOK || c.Traces != 10 || c.MinMs != 100 || c.P50Ms != 500 || c.P90Ms != 900 || c.MaxMs != 1000 ||
		c.Fastest[0].TraceID != "t01" || c.Slowest[0].TraceID != "t10" || c.Slowest[1].TraceID != "t09" || len(c.Typical) != 2 || c.Typical[0].TraceID != "t05" {
		t.Fatalf("compare %d %s", w.Code, w.Body)
	}
	if _, after := f.lastRow(t); after["kind"] != "compare" || after["traces"] != float64(10) {
		t.Fatalf("after %v", after)
	}
}

func TestTraceRefusals(t *testing.T) {
	scoped := podReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	nobody := auth.TokenPayload{UserID: "u9", Perms: auth.PermissionMatrix{"*": {"resource.deployment.read"}}}
	storeSays := func(status int, body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status); _, _ = w.Write([]byte(body)) }
	}
	ok := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"traces":[]}`)) }
	cases := []struct {
		name      string
		tempo     http.HandlerFunc
		target    string
		clusterID string
		namespace string
		payload   auth.TokenPayload
		status    int
		audited   bool
		asked     bool
		detail    string
	}{
		{"cluster without a trace store", ok, traceTarget("/api/v1/namespaces/shop/traces/search", "{}"), "test2", "shop", podReader, 404, false, false, "not configured"},
		{"no pod read", ok, traceTarget("/api/v1/namespaces/shop/traces/search", "{}"), "self", "shop", nobody, 403, false, false, ""},
		{"every namespace with a scoped grant", ok, traceTarget("/api/v1/traces/search", "{}"), "self", "", scoped, 403, false, false, "limited to namespaces"},
		{"no query", ok, "/api/v1/namespaces/shop/traces/search", "self", "shop", podReader, 400, false, false, "required"},
		{"range too long", ok, traceTarget("/api/v1/namespaces/shop/traces/search", "{}") + "&since=48h", "self", "shop", podReader, 400, false, false, "longer"},
		{"refused by the cluster", ok, traceTarget("/api/v1/namespaces/secret-team/traces/search", "{}"), "self", "secret-team", podReader, 403, true, false, "does not let you read pod logs"},
		{"parent span", ok, traceTarget("/api/v1/namespaces/shop/traces/search", `{ parent.span.a = 1 }`), "self", "shop", podReader, 400, true, false, "parent"},
		{"root service", ok, traceTarget("/api/v1/namespaces/shop/traces/search", `{ rootServiceName = "gw" }`), "self", "shop", podReader, 400, true, false, "outside your scope"},
		{"the store cannot run it", storeSays(400, "invalid TraceQL query: parse error"), traceTarget("/api/v1/namespaces/shop/traces/search", `{ .a = }`), "self", "shop", podReader, 400, true, true, "parse error"},
		{"the store fails", storeSays(503, "unavailable"), traceTarget("/api/v1/namespaces/shop/traces/search", `{}`), "self", "shop", podReader, 502, true, true, "503"},
		{"not Tempo", storeSays(404, "404 page not found"), traceTarget("/api/v1/namespaces/shop/traces/search", `{}`), "self", "shop", podReader, 404, true, true, "not served"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newTraceFixture(t, c.tempo)
			handler := f.h.TraceSearchNamespace
			if c.namespace == "" {
				handler = f.h.TraceSearchAll
			}
			w := f.serve(handler, logSearchRequestAs(c.target, c.clusterID, c.namespace, c.payload))
			if w.Code != c.status || !strings.Contains(w.Body.String(), c.detail) {
				t.Fatalf("status %d %s", w.Code, w.Body)
			}
			if c.audited != (len(f.store.rows) > 0) || (c.audited && f.store.rows[0].Result != audit.ResultFailure) {
				t.Fatalf("audit rows %+v, want audited=%v", f.store.rows, c.audited)
			}
			if c.asked != (len(f.requests) > 0) {
				t.Fatalf("store asked %d times, want asked=%v", len(f.requests), c.asked)
			}
		})
	}

	// a bad trace ID and a bad tag scope are refused before the cluster or the store is asked
	f := newTraceFixture(t, ok)
	w := f.serve(f.h.TraceGetAll, withTraceID(logSearchRequestAs("/api/v1/traces/trace/xyz", "self", "", podReader), "xyz"))
	if w.Code != http.StatusBadRequest || len(f.reviews) != 0 || len(f.requests) != 0 {
		t.Fatalf("bad trace ID: %d %s reviews %v", w.Code, w.Body, f.reviews)
	}
	w = f.serve(f.h.TraceTagsAll, logSearchRequestAs("/api/v1/traces/tags?scope=parent", "self", "", podReader))
	if w.Code != http.StatusBadRequest || len(f.requests) != 0 {
		t.Fatalf("bad scope: %d %s", w.Code, w.Body)
	}

	// the per-user rate (5 a minute in the fixture)
	f = newTraceFixture(t, ok)
	for i := 0; i < 6; i++ {
		w = f.serve(f.h.TraceSearchNamespace, logSearchRequestAs(traceTarget("/api/v1/namespaces/shop/traces/search", "{}"), "self", "shop", podReader))
	}
	if row, _ := f.lastRow(t); w.Code != http.StatusTooManyRequests || row.Result != audit.ResultFailure {
		t.Fatalf("sixth read %d", w.Code)
	}
}

func withTraceID(r *http.Request, id string) *http.Request {
	chi.RouteContext(r.Context()).URLParams.Add("traceID", id)
	return r
}
