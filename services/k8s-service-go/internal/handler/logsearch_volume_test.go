package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// loki_query's volume estimate (features.logSearch.queryMaxBytes): off asks the index nothing and answers as before.
func newVolumeFixture(t *testing.T, maxBytes int64, stats string) (*logSearchFixture, func() []string) {
	t.Helper()
	f := &logSearchFixture{store: &memAudit{}}
	var mu sync.Mutex
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path+" "+r.URL.Query().Get("query"))
		mu.Unlock()
		switch r.URL.Path {
		case "/loki/api/v1/index/stats":
			if stats == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(stats))
		default:
			lokiMatrix(1)(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	s, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: srv.URL,
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: time.Second, PerUserPerMinute: 20, QueryMaxBytes: maxBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = &Handler{auditStore: f.store}
	f.h.SetLogSearch(s)
	f.h.logSearchCanI = func(context.Context, string) (bool, error) { return true, nil }
	return f, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, paths...)
	}
}

const volumeQuery = `sum by (k8s_pod_name) (count_over_time({app="web"} |= "error" [5m]))`

func volumeTarget() string {
	return logqlTarget("/api/v1/namespaces/apps/logsearch/logql", volumeQuery, "&since=1h&step=300")
}

func TestLokiQueryWithoutAVolumeLimitAsksTheIndexNothing(t *testing.T) {
	off, offPaths := newVolumeFixture(t, 0, `{"bytes":1}`)
	w := off.serve(off.h.LogQLSearchNamespace, logSearchRequestAs(volumeTarget(), "self", "apps", podReader))
	if w.Code != http.StatusOK || len(offPaths()) != 1 || !strings.HasPrefix(offPaths()[0], "/loki/api/v1/query_range ") {
		t.Fatalf("%d %v", w.Code, offPaths())
	}
	if bytes.Contains(w.Body.Bytes(), []byte("estimated")) {
		t.Fatalf("an answer without the limit names an estimate: %s", w.Body)
	}
	_, after := lastAfter(t, off)
	if _, ok := after["estimated_bytes"]; ok {
		t.Fatalf("a row without the limit names an estimate: %v", after)
	}

	// with the limit and under it, the answer is the same but for the estimate it carries
	on, onPaths := newVolumeFixture(t, 1<<20, `{"streams":1,"chunks":1,"entries":10,"bytes":2048}`)
	w2 := on.serve(on.h.LogQLSearchNamespace, logSearchRequestAs(volumeTarget(), "self", "apps", podReader))
	var m map[string]interface{}
	if err := json.Unmarshal(w2.Body.Bytes(), &m); err != nil || w2.Code != http.StatusOK || m["estimatedBytes"] != float64(2048) {
		t.Fatalf("%d %s", w2.Code, w2.Body)
	}
	delete(m, "estimatedBytes")
	var offBody map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &offBody)
	if fmt.Sprint(m) != fmt.Sprint(offBody) {
		t.Fatalf("the answers differ past the estimate:\n%v\n%v", m, offBody)
	}
	if got := onPaths(); len(got) != 2 || got[0] != `/loki/api/v1/index/stats {k8s_cluster_name="kubeast", k8s_namespace_name="apps", app="web"}` {
		t.Fatalf("the index is asked first, for the selector as sent: %v", got)
	}
	_, after = lastAfter(t, on)
	if after["estimated_bytes"] != float64(2048) {
		t.Fatalf("%v", after)
	}
}

func TestLokiQueryPastTheVolumeLimitIsRefusedWithHowToNarrow(t *testing.T) {
	f, paths := newVolumeFixture(t, 1024, `{"streams":9,"chunks":90,"entries":100000,"bytes":5368709120}`)
	w := f.serve(f.h.LogQLSearchNamespace, logSearchRequestAs(volumeTarget(), "self", "apps", podReader))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "5.0 GiB, past features.logSearch.queryMaxBytes (1.0 KiB); narrow the time range or add label matchers") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := paths(); len(got) != 1 {
		t.Fatalf("read past the estimate: %v", got)
	}
	row, after := lastAfter(t, f)
	if row.Action != "k8s.pod.logs.logql" || row.Result != audit.ResultFailure || after["estimated_bytes"] != float64(5368709120) {
		t.Fatalf("row %+v after %v", row, after)
	}

	// a store without index stats is not read blind while the limit is set
	g, gPaths := newVolumeFixture(t, 1024, "")
	w = g.serve(g.h.LogQLSearchNamespace, logSearchRequestAs(volumeTarget(), "self", "apps", podReader))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "index stats") || len(gPaths()) != 1 {
		t.Fatalf("%d %s %v", w.Code, w.Body, gPaths())
	}
}
