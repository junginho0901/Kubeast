package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type logSearchFixture struct {
	h       *Handler
	store   *memAudit
	queries []string
	reviews []string
}

func newLogSearchFixture(t *testing.T, loki http.HandlerFunc) *logSearchFixture {
	t.Helper()
	f := &logSearchFixture{store: &memAudit{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.queries = append(f.queries, r.URL.Query().Get("query"))
		loki(w, r)
	}))
	t.Cleanup(srv.Close)
	s, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: srv.URL,
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: 200 * time.Millisecond, PerUserPerMinute: 2,
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

func lokiAnswers(lines ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		values := make([][2]string, len(lines))
		for i, l := range lines {
			values[i] = [2]string{"17604432000000000" + string(rune('9'-i)) + "0", l}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{
			"resultType": "streams",
			"result":     []interface{}{map[string]interface{}{"stream": map[string]string{"k8s_namespace_name": "apps", "k8s_pod_name": "web-1", "k8s_container_name": "app"}, "values": values}},
			"stats":      map[string]interface{}{"summary": map[string]interface{}{"totalBytesProcessed": 512}},
		}})
	}
}

// logSearchRequestAs builds a request the way the middleware would leave it.
func logSearchRequestAs(target, clusterID, namespace string, payload auth.TokenPayload) *http.Request {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
	ctx = cluster.WithID(ctx, cluster.ID(clusterID))
	rc := chi.NewRouteContext()
	if namespace != "" {
		rc.URLParams.Add("namespace", namespace)
	}
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	return r.WithContext(ctx)
}

var podReader = auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read"}}}

func (f *logSearchFixture) do(r *http.Request, namespace string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	if namespace == "" {
		f.h.LogSearchAll(w, r)
	} else {
		f.h.LogSearchNamespace(w, r)
	}
	return w
}

func TestLogSearchFindsLinesAndAudits(t *testing.T) {
	f := newLogSearchFixture(t, lokiAnswers("panic: boom", "started"))
	w := f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch?q=boom&container=app&since=30m", "self", "apps", podReader), "apps")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res logsearch.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || len(res.Lines) != 2 || res.Lines[0].Line != "panic: boom" || res.Bytes != 512 {
		t.Fatalf("body %s (%v)", w.Body, err)
	}
	if f.queries[0] != `{k8s_cluster_name="kubeast", k8s_namespace_name="apps", k8s_container_name="app"} |= "boom"` {
		t.Fatalf("query %s", f.queries[0])
	}
	if len(f.reviews) != 1 || f.reviews[0] != "apps" {
		t.Fatalf("pods/log review %v", f.reviews)
	}
	if len(f.store.rows) != 1 {
		t.Fatalf("audit rows %d", len(f.store.rows))
	}
	row := f.store.rows[0]
	var after map[string]interface{}
	_ = json.Unmarshal(row.After, &after)
	if row.Action != "k8s.pod.logs.search" || row.Result == audit.ResultFailure || row.Namespace != "apps" ||
		after["q"] != "boom" || after["lines"] != float64(2) || after["range_seconds"] != float64(1800) || after["container"] != "app" {
		t.Fatalf("audit %+v after %v", row, after)
	}
	if strings.Contains(string(row.After), "panic") {
		t.Fatal("the audit row carries a log line")
	}
}

func TestLogSearchRefusals(t *testing.T) {
	scoped := podReader
	scoped.Namespaces = map[string][]string{"self": {"apps"}}
	cases := []struct {
		name      string
		target    string
		clusterID string
		namespace string
		payload   auth.TokenPayload
		status    int
		auditFail bool
	}{
		{"cluster without log search", "/api/v1/namespaces/apps/logsearch", "test2", "apps", podReader, 404, false},
		{"no pod read permission", "/api/v1/namespaces/apps/logsearch", "self", "apps", auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.node.read"}}}, 403, false},
		{"namespace-scoped grant searching every namespace", "/api/v1/logsearch", "self", "", scoped, 403, false},
		{"the cluster refuses pods/log", "/api/v1/namespaces/secret-team/logsearch", "self", "secret-team", podReader, 403, true},
		{"bad regex", "/api/v1/namespaces/apps/logsearch?q=(&match=regex", "self", "apps", podReader, 400, false},
		{"range over the maximum", "/api/v1/namespaces/apps/logsearch?since=48h", "self", "apps", podReader, 400, false},
	}
	for _, tc := range cases {
		f := newLogSearchFixture(t, lokiAnswers("x"))
		w := f.do(logSearchRequestAs(tc.target, tc.clusterID, tc.namespace, tc.payload), tc.namespace)
		if w.Code != tc.status {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, w.Code, tc.status, w.Body)
		}
		if len(f.queries) != 0 {
			t.Errorf("%s: the store was queried", tc.name)
		}
		failed := len(f.store.rows) == 1 && f.store.rows[0].Result == audit.ResultFailure && f.store.rows[0].Action == "k8s.pod.logs.search"
		if tc.auditFail != failed {
			t.Errorf("%s: failure audit row %v, rows %+v", tc.name, failed, f.store.rows)
		}
	}
}

func TestLogSearchEveryNamespaceForAnUnscopedGrant(t *testing.T) {
	f := newLogSearchFixture(t, lokiAnswers("x"))
	w := f.do(logSearchRequestAs("/api/v1/logsearch?q=x", "self", "", podReader), "")
	if w.Code != http.StatusOK || f.reviews[0] != "" || !strings.Contains(f.queries[0], `k8s_namespace_name=~".+"`) {
		t.Fatalf("status %d reviews %v query %v", w.Code, f.reviews, f.queries)
	}
}

func TestLogSearchRateLimitAndStoreErrors(t *testing.T) {
	f := newLogSearchFixture(t, lokiAnswers("x"))
	for i := 0; i < 2; i++ {
		if w := f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "self", "apps", podReader), "apps"); w.Code != 200 {
			t.Fatalf("search %d: %d", i+1, w.Code)
		}
	}
	w := f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "self", "apps", podReader), "apps")
	if w.Code != http.StatusTooManyRequests || len(f.queries) != 2 || f.store.rows[2].Result != audit.ResultFailure {
		t.Fatalf("3rd search: %d, queries %d, row %+v", w.Code, len(f.queries), f.store.rows[2])
	}

	broken := newLogSearchFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "too many outstanding requests", 429) })
	if w := broken.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "self", "apps", podReader), "apps"); w.Code != http.StatusBadGateway ||
		broken.store.rows[0].Result != audit.ResultFailure || !strings.Contains(broken.store.rows[0].Error, "429") {
		t.Fatalf("store error: %d %+v", w.Code, broken.store.rows)
	}
	slow := newLogSearchFixture(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(time.Second) })
	if w := slow.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "self", "apps", podReader), "apps"); w.Code != http.StatusGatewayTimeout {
		t.Fatalf("timeout: %d", w.Code)
	}
}

func TestLogSearchFeature(t *testing.T) {
	if got := (&Handler{}).logSearchFeature(); got["enabled"] != false {
		t.Fatalf("off: %v", got)
	}
	f := newLogSearchFixture(t, lokiAnswers())
	got := f.h.logSearchFeature()
	if got["enabled"] != true || got["maxLines"] != 100 || got["maxRangeMinutes"] != 1440 || len(got["clusters"].([]string)) != 1 {
		t.Fatalf("on: %v", got)
	}
}
