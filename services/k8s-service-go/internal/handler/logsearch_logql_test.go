package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A fixture with LogQL queries on (features.logSearch.logql).
func newLogQLFixture(t *testing.T, loki http.HandlerFunc) *logSearchFixture {
	t.Helper()
	f := &logSearchFixture{store: &memAudit{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.queries = append(f.queries, r.URL.Query().Get("query"))
		loki(w, r)
	}))
	t.Cleanup(srv.Close)
	s, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: srv.URL, LogQLEnabled: true,
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: 200 * time.Millisecond, PerUserPerMinute: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store}
	f.h.SetLogSearch(s)
	f.h.logSearchCanI = func(_ context.Context, ns string) (bool, error) {
		f.reviews = append(f.reviews, ns)
		return ns != "secret-team", nil
	}
	return f
}

// Anyone who may search logs writes LogQL: pod read is the only permission asked.
var logqlUser = auth.TokenPayload{UserID: "a1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}

func (f *logSearchFixture) logql(r *http.Request, namespace string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	if namespace == "" {
		f.h.LogQLAll(w, r)
	} else {
		f.h.LogQLNamespace(w, r)
	}
	return w
}

func logqlTarget(path, q, rest string) string {
	return path + "?q=" + url.QueryEscape(q) + rest
}

func TestLogQLRunsWithTheScopeAddedAndAudits(t *testing.T) {
	f := newLogQLFixture(t, lokiAnswers("panic: boom"))
	raw := `{app="web"} |= "boom"`
	w := f.logql(logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/query", raw, "&since=30m"), "self", "apps", logqlUser), "apps")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res logsearch.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || len(res.Lines) != 1 || res.Lines[0].Line != "panic: boom" {
		t.Fatalf("body %s (%v)", w.Body, err)
	}
	want := `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="web"} |= "boom"`
	if res.EffectiveQuery != want || f.queries[0] != want {
		t.Fatalf("effective %q, sent %q", res.EffectiveQuery, f.queries[0])
	}
	if len(f.reviews) != 1 || f.reviews[0] != "apps" {
		t.Fatalf("pods/log review %v", f.reviews)
	}
	row := f.store.rows[len(f.store.rows)-1]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	if row.Action != "k8s.pod.logs.logql" || row.Result == audit.ResultFailure || row.Namespace != "apps" ||
		after["logql"] != raw || after["effective"] != want || after["lines"] != float64(1) || after["range_seconds"] != float64(1800) {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "panic") {
		t.Fatal("the audit row carries a log line")
	}

	// every namespace, for an unscoped admin: the cluster matcher only
	w = f.logql(logSearchRequestAs(logqlTarget("/api/v1/logsearch/query", raw, ""), "self", "", logqlUser), "")
	if w.Code != http.StatusOK || f.queries[1] != `{k8s_cluster_name="kubeast", app="web"} |= "boom"` {
		t.Fatalf("every namespace: %d %s sent %q", w.Code, w.Body, f.queries[1])
	}
}

func TestLogQLRefusals(t *testing.T) {
	noPodRead := auth.TokenPayload{UserID: "u3", Perms: auth.PermissionMatrix{"*": {"resource.deployment.read"}}}
	scoped := logqlUser
	scoped.Namespaces = map[string][]string{"self": {"apps"}}
	metric := func(w http.ResponseWriter, _ *http.Request) {
		// Loki's samples carry a number timestamp, unlike a stream's [string, string] values
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1760443200,"1"]]}]}}`))
	}
	cases := []struct {
		name      string
		fixture   *logSearchFixture
		path      string
		q         string
		clusterID string
		namespace string
		payload   auth.TokenPayload
		status    int
		auditFail bool
		detail    string
	}{
		{"LogQL off", newLogSearchFixture(t, lokiAnswers()), "/api/v1/namespaces/apps/logsearch/query", `{app="web"}`, "self", "apps", logqlUser, 404, false, "features.logSearch.logql"},
		{"cluster without log search", newLogQLFixture(t, lokiAnswers()), "/api/v1/namespaces/apps/logsearch/query", `{app="web"}`, "test2", "apps", logqlUser, 404, false, "not configured"},
		{"no pod read", newLogQLFixture(t, lokiAnswers()), "/api/v1/namespaces/apps/logsearch/query", `{app="web"}`, "self", "apps", noPodRead, 403, false, ""},
		{"every namespace with a scoped grant", newLogQLFixture(t, lokiAnswers()), "/api/v1/logsearch/query", `{app="web"}`, "self", "", scoped, 403, false, "limited to namespaces"},
		{"refused by the cluster", newLogQLFixture(t, lokiAnswers()), "/api/v1/namespaces/secret-team/logsearch/query", `{app="web"}`, "self", "secret-team", logqlUser, 403, true, "does not let you read pod logs"},
		{"no stream selector", newLogQLFixture(t, lokiAnswers()), "/api/v1/namespaces/apps/logsearch/query", `|= "x"`, "self", "apps", logqlUser, 400, true, "no stream selector"},
		{"unterminated selector", newLogQLFixture(t, lokiAnswers()), "/api/v1/namespaces/apps/logsearch/query", `{app="web"`, "self", "apps", logqlUser, 400, true, "unterminated"},
		{"a metric query", newLogQLFixture(t, metric), "/api/v1/namespaces/apps/logsearch/query", `sum(rate({app="web"}[5m]))`, "self", "apps", logqlUser, 400, true, "metric"},
		{"a store that refuses", newLogQLFixture(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("parse error"))
		}), "/api/v1/namespaces/apps/logsearch/query", `{app="web"} | nonsense`, "self", "apps", logqlUser, 502, true, "parse error"},
	}
	for _, c := range cases {
		w := c.fixture.logql(logSearchRequestAs(logqlTarget(c.path, c.q, ""), c.clusterID, c.namespace, c.payload), c.namespace)
		if w.Code != c.status || !strings.Contains(w.Body.String(), c.detail) {
			t.Errorf("%s: %d %s (want %d with %q)", c.name, w.Code, w.Body, c.status, c.detail)
		}
		if c.auditFail {
			rows := c.fixture.store.rows
			if len(rows) == 0 || rows[len(rows)-1].Action != "k8s.pod.logs.logql" || rows[len(rows)-1].Result != audit.ResultFailure {
				t.Errorf("%s: no failure audit row (%+v)", c.name, rows)
			}
		}
		if len(c.fixture.queries) != 0 && c.status != 400 && c.status != 502 {
			t.Errorf("%s: the store was asked: %v", c.name, c.fixture.queries)
		}
	}
}

func TestLogQLRateLimit(t *testing.T) {
	f := newLogQLFixture(t, lokiAnswers("x"))
	var last int
	for i := 0; i < 6; i++ {
		last = f.logql(logSearchRequestAs(logqlTarget("/api/v1/namespaces/apps/logsearch/query", `{app="web"}`, ""), "self", "apps", logqlUser), "apps").Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("the 6th query in a minute: %d", last)
	}
}
