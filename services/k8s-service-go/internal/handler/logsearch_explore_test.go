package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The loki_* tools' reads go through the structured search's door: a pod
// reader gets them, with the scope added.

func (f *logSearchFixture) serve(handler func(http.ResponseWriter, *http.Request), r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

func lokiMatrix(series int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result := make([]string, series)
		for i := range result {
			result[i] = fmt.Sprintf(`{"metric":{"k8s_pod_name":"web-%d"},"values":[[1760443200,"%d"],[1760443500,"2.5"],[1760443800,"bad"]]}`, i, i+1)
		}
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"matrix","result":[%s]}}`, strings.Join(result, ","))
	}
}

func lastAfter(t *testing.T, f *logSearchFixture) (audit.Record, map[string]interface{}) {
	t.Helper()
	if len(f.store.rows) == 0 {
		t.Fatal("no audit row")
	}
	row := f.store.rows[len(f.store.rows)-1]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	return row, after
}

func TestLogQLSearchRunsAMetricQueryForAPodReader(t *testing.T) {
	var step string
	f := newLogSearchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		step = r.URL.Query().Get("step")
		lokiMatrix(2)(w, r)
	})
	raw := `sum by (k8s_pod_name) (count_over_time({app="web"} |= "error" [5m]))`
	w := f.serve(f.h.LogQLSearchNamespace, logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/logql", raw, "&since=1h&step=300"), "self", "apps", podReader))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res logsearch.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	want := `sum by (k8s_pod_name) (count_over_time({k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="web"} |= "error" [5m]))`
	if res.ResultType != "matrix" || res.EffectiveQuery != want || f.queries[0] != want || step != "300" || res.StepSeconds != 300 {
		t.Fatalf("result %+v sent %q step %q", res, f.queries[0], step)
	}
	if len(res.Series) != 2 || res.Series[1].Metric["k8s_pod_name"] != "web-1" || len(res.Series[1].Points) != 2 ||
		res.Series[1].Points[0] != (logsearch.Point{T: 1760443200, V: 2}) || res.Series[1].Points[1].V != 2.5 {
		t.Fatalf("series %+v (an unreadable sample is skipped)", res.Series)
	}
	row, after := lastAfter(t, f)
	if row.Action != "k8s.pod.logs.logql" || row.Result == audit.ResultFailure || after["kind"] != "metric" || after["series"] != float64(2) ||
		after["effective"] != want || after["logql"] != raw || after["range_seconds"] != float64(3600) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if _, ok := after["lines"]; ok {
		t.Fatalf("a metric answer has no lines: %v", after)
	}
}

func TestLogQLSearchLogQueryAndSeriesCap(t *testing.T) {
	f := newLogSearchFixture(t, lokiAnswers("level=error msg=boom"))
	w := f.serve(f.h.LogQLSearchAll, logSearchRequestAs(logqlTarget("/api/v1/logsearch/logql", `{app="web"} | logfmt | level="error"`, ""), "self", "", podReader))
	var res logsearch.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || res.ResultType != "streams" || len(res.Lines) != 1 || f.queries[0] != `{k8s_cluster_name="kubeast", app="web"} | logfmt | level="error"` {
		t.Fatalf("status %d %s sent %v", w.Code, w.Body, f.queries)
	}
	if _, after := lastAfter(t, f); after["kind"] != "log" || after["lines"] != float64(1) || strings.Contains(fmt.Sprint(after), "boom") {
		t.Fatalf("after %v", after)
	}

	f = newLogSearchFixture(t, lokiMatrix(logsearch.MaxSeries+5))
	w = f.serve(f.h.LogQLSearchAll, logSearchRequestAs(logqlTarget("/api/v1/logsearch/logql", `rate({app="web"}[1m])`, ""), "self", "", podReader))
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || len(res.Series) != logsearch.MaxSeries || !res.Truncated {
		t.Fatalf("status %d series %d truncated %v", w.Code, len(res.Series), res.Truncated)
	}
}

func TestLogQLSearchRefusals(t *testing.T) {
	scoped := podReader
	scoped.Namespaces = map[string][]string{"self": {"apps"}}
	storeSays := func(status int, body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status); _, _ = w.Write([]byte(body)) }
	}
	nobody := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.deployment.read"}}}
	cases := []struct {
		name      string
		loki      http.HandlerFunc
		path      string
		q         string
		clusterID string
		namespace string
		payload   auth.TokenPayload
		status    int
		audited   bool
		detail    string
	}{
		{"cluster without log search", lokiAnswers(), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"}`, "test2", "apps", podReader, 404, false, "not configured"},
		{"no pod read", lokiAnswers(), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"}`, "self", "apps", nobody, 403, false, ""},
		{"every namespace with a scoped grant", lokiAnswers(), "/api/v1/logsearch/logql", `{app="web"}`, "self", "", scoped, 403, false, "limited to namespaces"},
		{"no query", lokiAnswers(), "/api/v1/namespaces/apps/logsearch/logql", ` `, "self", "apps", podReader, 400, false, "required"},
		{"step longer than the range", lokiAnswers(), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"}`, "self", "apps", podReader, 400, false, "step"},
		{"refused by the cluster", lokiAnswers(), "/api/v1/namespaces/secret-team/logsearch/logql", `{app="web"}`, "self", "secret-team", podReader, 403, true, "does not let you read pod logs"},
		{"unterminated selector", lokiAnswers(), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"`, "self", "apps", podReader, 400, true, "unterminated"},
		{"the store cannot parse it", storeSays(400, "parse error at line 1"), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"} | nope`, "self", "apps", podReader, 400, true, "parse error"},
		{"the store fails", storeSays(500, "boom"), "/api/v1/namespaces/apps/logsearch/logql", `{app="web"}`, "self", "apps", podReader, 502, true, "500"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newLogSearchFixture(t, c.loki)
			target := logqlTarget(c.path, c.q, "&since=10m")
			if strings.HasPrefix(c.name, "step") {
				target += "&step=3600"
			}
			w := f.serve(f.h.LogQLSearchNamespace, logSearchRequestAs(target, c.clusterID, c.namespace, c.payload))
			if c.namespace == "" {
				w = f.serve(f.h.LogQLSearchAll, logSearchRequestAs(target, c.clusterID, "", c.payload))
			}
			if w.Code != c.status || !strings.Contains(w.Body.String(), c.detail) {
				t.Fatalf("status %d %s", w.Code, w.Body)
			}
			if c.audited != (len(f.store.rows) > 0) {
				t.Fatalf("audit rows %d, want audited=%v", len(f.store.rows), c.audited)
			}
			if c.audited && f.store.rows[len(f.store.rows)-1].Result != audit.ResultFailure {
				t.Fatal("a refused read is a failure row")
			}
			if c.status == 400 && !c.audited && len(f.reviews) > 0 {
				t.Fatalf("a bad request asked the cluster: %v", f.reviews)
			}
		})
	}

	// the per-user rate (2 a minute in the fixture) counts these reads too
	f := newLogSearchFixture(t, lokiAnswers("x"))
	var w *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		w = f.serve(f.h.LogQLSearchNamespace, logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/logql", `{app="web"}`, ""), "self", "apps", podReader))
	}
	if row, _ := lastAfter(t, f); w.Code != http.StatusTooManyRequests || row.Result != audit.ResultFailure {
		t.Fatalf("third read %d, row %+v", w.Code, row)
	}
}

func TestLogLabelsStayInTheScope(t *testing.T) {
	var paths []string
	f := newLogSearchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/values") {
			values := make([]string, logsearch.MaxLabelValues+3)
			for i := range values {
				values[i] = fmt.Sprintf("web-%03d", len(values)-i)
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": values})
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":["k8s_pod_name","__stream_shard__","app","k8s_cluster_name"]}`))
	})
	w := f.serve(f.h.LogLabelsNamespace, logSearchRequestAs("/api/v1/namespaces/apps/logsearch/labels", "self", "apps", podReader))
	var res logsearch.LabelsResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	sel := `{k8s_cluster_name="kubeast", k8s_namespace_name="apps"}`
	if w.Code != http.StatusOK || strings.Join(res.Values, ",") != "app,k8s_cluster_name,k8s_pod_name" || f.queries[0] != sel || paths[0] != "/loki/api/v1/labels" {
		t.Fatalf("status %d %s sent %q %v", w.Code, w.Body, f.queries, paths)
	}

	w = f.serve(f.h.LogLabelsAll, logSearchRequestAs("/api/v1/logsearch/labels?label=k8s_pod_name&since=6h", "self", "", podReader))
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if w.Code != http.StatusOK || res.Label != "k8s_pod_name" || len(res.Values) != logsearch.MaxLabelValues || !res.Truncated || res.Values[0] != "web-001" ||
		paths[1] != "/loki/api/v1/label/k8s_pod_name/values" || f.queries[1] != `{k8s_cluster_name="kubeast", k8s_namespace_name=~".+"}` {
		t.Fatalf("values: %d %d %v %v %q", w.Code, len(res.Values), res.Truncated, paths, f.queries)
	}

	w = f.serve(f.h.LogLabelsAll, logSearchRequestAs(`/api/v1/logsearch/labels?label=a%22b`, "self", "", podReader))
	if w.Code != http.StatusBadRequest || len(paths) != 2 {
		t.Fatalf("a bad label name: %d %s (store asked %d times)", w.Code, w.Body, len(paths))
	}
	if len(f.store.rows) != 0 {
		t.Fatalf("label lists are not audited: %d rows", len(f.store.rows))
	}
	w = f.serve(f.h.LogLabelsNamespace, logSearchRequestAs("/api/v1/namespaces/secret-team/logsearch/labels", "self", "secret-team", podReader))
	if w.Code != http.StatusForbidden || len(paths) != 2 {
		t.Fatalf("refused by the cluster: %d", w.Code)
	}
}

func TestLogPatternsCountedAndAudited(t *testing.T) {
	f := newLogSearchFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":[
			{"pattern":"<_> level=info msg=served <_>","level":"info","samples":[[1760443200,3],[1760443210,4]]},
			{"pattern":"<_> level=error msg=\"db timeout\" <_>","level":"error","samples":[[1760443100,10],[1760443300,15]]}]}`))
	})
	w := f.serve(f.h.LogPatternsNamespace, logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/patterns", `{app="web"}`, "&since=3h"), "self", "apps", podReader))
	var res logsearch.PatternsResult
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	want := `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="web"}`
	if w.Code != http.StatusOK || len(res.Patterns) != 2 || res.EffectiveQuery != want || f.queries[0] != want {
		t.Fatalf("status %d %s sent %v", w.Code, w.Body, f.queries)
	}
	top := res.Patterns[0]
	if top.Level != "error" || top.Count != 25 || top.First.Unix() != 1760443100 || top.Last.Unix() != 1760443300 || res.Patterns[1].Count != 7 {
		t.Fatalf("patterns %+v", res.Patterns)
	}
	row, after := lastAfter(t, f)
	if row.Action != "k8s.pod.logs.logql" || after["kind"] != "patterns" || after["patterns"] != float64(2) || after["effective"] != want || strings.Contains(string(row.After), "timeout") {
		t.Fatalf("audit %+v after %v", row, after)
	}

	off := newLogSearchFixture(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	w = off.serve(off.h.LogPatternsNamespace, logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/patterns", `{app="web"}`, ""), "self", "apps", podReader))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "not served") || !strings.Contains(w.Body.String(), "pattern_ingester") {
		t.Fatalf("patterns off: %d %s", w.Code, w.Body)
	}
	if row, _ := lastAfter(t, off); row.Result != audit.ResultFailure {
		t.Fatalf("row %+v", row)
	}
}
