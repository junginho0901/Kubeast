package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
)

// A cluster that names its own store searches there although the deployment-wide map does not list it; the
// feature lists it; the status says which store a cluster reads from.
func TestLogSearchOwnStoreClusterAndStatus(t *testing.T) {
	f := newLogSearchFixture(t, lokiAnswers("from the deployment store"))
	own := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/loki/api/v1/labels" {
			_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
			return
		}
		lokiAnswers("from the cluster's own store")(w, r)
	}))
	t.Cleanup(own.Close)
	f.h.logSearch.OwnStore = func(_ context.Context, id string) *logsearch.Store {
		if id == "b" {
			return &logsearch.Store{URL: own.URL}
		}
		return nil
	}
	f.h.logSearch.OwnStoreClusters = func(context.Context) []string { return []string{"b"} }

	w := f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "b", "apps", podReader), "apps")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "from the cluster's own store") {
		t.Fatalf("b on its own store: %d %s", w.Code, w.Body.String())
	}
	if len(f.queries) != 0 {
		t.Fatalf("the deployment-wide store was asked: %v", f.queries)
	}
	w = f.do(logSearchRequestAs("/api/v1/namespaces/apps/logsearch", "self", "apps", podReader), "apps")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "from the deployment store") || len(f.queries) != 1 {
		t.Fatalf("self on the deployment-wide store: %d %s %v", w.Code, w.Body.String(), f.queries)
	}

	if got := f.h.logSearchFeature(context.Background())["clusters"].([]string); strings.Join(got, ",") != "b,self" {
		t.Fatalf("feature clusters %v", got)
	}

	status := func(cluster string) map[string]interface{} {
		rec := httptest.NewRecorder()
		f.h.LogSearchStatus(rec, logSearchRequestAs("/api/v1/logsearch/status", cluster, "", podReader))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %s: %d %s", cluster, rec.Code, rec.Body.String())
		}
		var out map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if st := status("b"); st["source"] != "cluster" || st["available"] != true || st["endpoint"] != own.URL {
		t.Fatalf("b: %v", st)
	}
	if st := status("self"); st["source"] != "global" || st["available"] != true {
		t.Fatalf("self: %v", st)
	}
	if st := status("nope"); st["source"] != "none" || st["available"] != false {
		t.Fatalf("nope: %v", st)
	}

	rec := httptest.NewRecorder()
	(&Handler{}).LogSearchStatus(rec, httptest.NewRequest(http.MethodGet, "/api/v1/logsearch/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"available":false`) {
		t.Fatalf("off: %d %s", rec.Code, rec.Body.String())
	}
}
