package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/traces"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The narrowing's log and trace checks against a stand-in Loki and Tempo. The window is 00:30–01:30 of anomalyNow's
// day and the one before 23:30–00:30, so the trace steps are 15 minutes.
type storeFixture struct {
	h        *Handler
	audit    *memAudit
	mu       sync.Mutex
	loki     []*http.Request
	tempo    []*http.Request
	stats    string // the index stats answer
	lines    string // the answer to a query_range with no step (the one-line read)
	tempoOff bool   // Tempo answers 404 for metrics
	reviews  []string
	canLogs  bool
}

func (f *storeFixture) lokiPaths() []string {
	out := []string{}
	for _, r := range f.lokiReqs() {
		out = append(out, r.URL.Path)
	}
	return out
}

// lokiReqs, tempoReqs and reviewed copy what the stand-ins saw.
func (f *storeFixture) lokiReqs() []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*http.Request{}, f.loki...)
}

func (f *storeFixture) tempoReqs() []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*http.Request{}, f.tempo...)
}

func (f *storeFixture) reads() int { return len(f.lokiReqs()) + len(f.tempoReqs()) }

func unixAt(h, m int) int64 { return time.Date(2026, 11, 15, h, m, 0, 0, time.UTC).Unix() }

func newStoreFixture(t *testing.T, cfg config.Config) *storeFixture {
	t.Helper()
	f := &storeFixture{audit: &memAudit{}, stats: `{"streams":3,"chunks":4,"entries":1000,"bytes":2048}`, canLogs: true,
		lines: `{"status":"success","data":{"resultType":"streams","result":[]}}`}
	loki := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.loki = append(f.loki, r)
		f.mu.Unlock()
		switch r.URL.Path {
		case "/loki/api/v1/index/stats":
			_, _ = w.Write([]byte(f.stats))
		case "/loki/api/v1/patterns":
			_, _ = fmt.Fprintf(w, `{"status":"success","data":[
				{"pattern":"level=error msg=\"dial tcp <_>: connection refused\"","level":"error","samples":[[%d,6],[%d,6]]},
				{"pattern":"GET /healthz <_>","level":"info","samples":[[%d,40],[%d,40]]}]}`,
				unixAt(0, 40), unixAt(1, 0), unixAt(0, 0), unixAt(1, 0))
		case "/loki/api/v1/query_range":
			if r.URL.Query().Get("step") == "" {
				_, _ = w.Write([]byte(f.lines))
				return
			}
			_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"matrix","result":[
				{"metric":{"k8s_container_name":"app"},"values":[[%d,"2"],[%d,"9"]]},
				{"metric":{"k8s_container_name":"sidecar"},"values":[[%d,"4"],[%d,"5"]]}]}}`,
				unixAt(0, 30), unixAt(1, 30), unixAt(0, 30), unixAt(1, 30))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(loki.Close)
	tempo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.tempo = append(f.tempo, r)
		off := f.tempoOff
		f.mu.Unlock()
		if off || r.URL.Path != "/api/metrics/query_range" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query().Get("q")
		// steps labelled by their start; those on a window's bound (00:30, 01:30) carry a value no window may read
		before, now, bound := 100.0, 100.0, 1e6
		switch {
		case strings.Contains(q, "status = error"):
			before, now = 0, 10
		case strings.Contains(q, "quantile_over_time"):
			before, now, bound = 0.05, 0.3, 9
		}
		var samples []string
		for ts := unixAt(23-24, 30); ts <= unixAt(1, 30); ts += 900 {
			v := now
			if ts < unixAt(0, 30) {
				v = before
			}
			if ts == unixAt(0, 30) || ts == unixAt(1, 30) {
				v = bound
			}
			samples = append(samples, fmt.Sprintf(`{"timestampMs":"%d","value":%g}`, ts*1000, v))
		}
		_, _ = fmt.Fprintf(w, `{"series":[{"labels":[{"key":"resource.service.name","value":{"stringValue":"cart"}}],"samples":[%s]}]}`, strings.Join(samples, ","))
	}))
	t.Cleanup(tempo.Close)

	s, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: loki.URL,
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: time.Second, PerUserPerMinute: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts, err := traces.New(traces.Config{
		Enabled: true, URL: tempo.URL, ClusterAttribute: "k8s.cluster.name", NamespaceAttribute: "k8s.namespace.name",
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 72 * time.Hour, MaxTraces: 20, Timeout: time.Second, PerUserPerMinute: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg.AnomalyRankEnabled = true
	f.h = &Handler{cfg: cfg, auditStore: f.audit, anomalySrc: &fakeAnomalies{}, anomalyNow: func() time.Time { return anomalyNow }}
	f.h.SetLogSearch(s)
	f.h.SetTraceStore(ts)
	f.h.logSearchCanI = func(_ context.Context, ns string) (bool, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.reviews = append(f.reviews, ns)
		return f.canLogs, nil
	}
	return f
}

func (f *storeFixture) get(t *testing.T, namespace string, payload auth.TokenPayload) anomaly.Result {
	t.Helper()
	w := httptest.NewRecorder()
	f.h.GetNamespaceAnomalies(w, logSearchRequestAs("/api/v1/namespaces/"+namespace+"/anomalies", "self", namespace, payload))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var res anomaly.Result
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func notRunOf(res anomaly.Result) map[string]string {
	out := map[string]string{}
	for _, n := range res.NotRun {
		out[n.Check] = n.Reason
	}
	return out
}

func TestAnomaliesReadTheLogAndTraceStoresAndLeaveTheirRows(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	res := f.get(t, "shop", podReader)
	found := map[string]anomaly.Finding{}
	for _, finding := range res.Findings {
		found[finding.Check+":"+finding.Target] = finding
	}
	shape := found[anomaly.CheckErrorLogShapes+`:level=error msg="dial tcp <_>: connection refused"`]
	if !shape.New || *shape.Now != 12 {
		t.Fatalf("the new error shape: %+v in %+v", shape, res.Findings)
	}
	if c := found[anomaly.CheckErrorLogCounts+":container app"]; c.Verdict != anomaly.VerdictAnomalous || *c.Ratio != 4.5 {
		t.Fatalf("error lines of app: %+v", res.Findings)
	}
	if e := found[anomaly.CheckTraceErrors+":service cart"]; e.Verdict != anomaly.VerdictAnomalous || *e.Now != 0.1 {
		t.Fatalf("failed spans of cart: %+v", res.Findings)
	}
	if l := found[anomaly.CheckTraceLatency+":service cart"]; l.Verdict != anomaly.VerdictAnomalous || *l.Ratio != 6 {
		t.Fatalf("p90 of cart: %+v", res.Findings)
	}
	// the steps on the windows' bounds (a million spans) were read by neither window
	if !strings.Contains(strings.Join(res.Normal, ","), anomaly.CheckTraceRequests) {
		t.Fatalf("normal %v not run %+v", res.Normal, res.NotRun)
	}
	if res.StoreQueries != 6 {
		t.Fatalf("%d store queries (no Prometheus: an estimate, shapes, counts and three trace queries)", res.StoreQueries)
	}

	// each read kept to the cluster and the namespace, the estimate over both windows
	for _, r := range f.lokiReqs() {
		q := r.URL.Query().Get("query")
		if !strings.Contains(q, `k8s_cluster_name="kubeast", k8s_namespace_name="shop"`) {
			t.Errorf("%s without the scope: %s", r.URL.Path, q)
		}
		if r.URL.Path != "/loki/api/v1/query_range" && r.URL.Query().Get("start") != fmt.Sprint(unixAt(23-24, 30)*1e9) {
			t.Errorf("%s does not cover the window before: %s", r.URL.Path, r.URL.Query().Get("start"))
		}
	}
	if got := strings.Join(f.lokiPaths(), ","); !strings.HasPrefix(got, "/loki/api/v1/index/stats,") || len(f.lokiReqs()) != 3 {
		t.Fatalf("the estimate first, then two reads: %s", got)
	}
	for _, r := range f.tempoReqs() {
		if q := r.URL.Query().Get("q"); !strings.Contains(q, `resource.k8s.namespace.name = "shop"`) || r.URL.Query().Get("step") != "900s" {
			t.Errorf("trace query %s step %s", q, r.URL.Query().Get("step"))
		}
	}
	f.mu.Lock()
	reviews := append([]string{}, f.reviews...)
	f.mu.Unlock()
	if len(reviews) != 1 || reviews[0] != "shop" {
		t.Fatalf("one pods/log review for both stores: %v", reviews)
	}

	// one row per store, the queries as sent and counts, never a line, a shape or a span
	if len(f.audit.rows) != 2 {
		t.Fatalf("%d audit rows", len(f.audit.rows))
	}
	actions := []string{}
	for _, row := range f.audit.rows {
		actions = append(actions, row.Action)
		var after map[string]interface{}
		_ = json.Unmarshal(row.After, &after)
		if row.Namespace != "shop" || row.Result != audit.ResultSuccess || after["kind"] != "anomaly" || after["range_seconds"] != float64(7200) {
			t.Errorf("row %+v after %v", row, after)
		}
		if strings.Contains(string(row.After), "connection refused") || strings.Contains(string(row.After), "healthz") {
			t.Errorf("a row holds what the store read: %s", row.After)
		}
	}
	if strings.Join(actions, ",") != "k8s.pod.logs.logql,k8s.traces.query" {
		t.Fatalf("actions %v", actions)
	}

	// the same question a moment later is the answer already made, its rows written again
	reads := f.reads()
	again := f.get(t, "shop", podReader)
	if f.reads() != reads || len(again.Findings) != len(res.Findings) || len(f.audit.rows) != 4 || !strings.Contains(string(f.audit.rows[3].After), `"cached":true`) {
		t.Fatalf("asked again: %d reads, %d rows", f.reads()-reads, len(f.audit.rows))
	}
}

func TestAnomaliesLogChecksPastTheEstimateAreTooLarge(t *testing.T) {
	f := newStoreFixture(t, config.Config{AnomalyRankLogMaxBytes: 1024})
	res := f.get(t, "shop", podReader)
	notRun := notRunOf(res)
	for _, check := range anomaly.LogChecks {
		if !strings.HasPrefix(notRun[check], "too large: the log store's index puts these logs over the window and the one before at 2.0 KiB, past features.anomalyRank.logMaxBytes (1.0 KiB)") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if got := strings.Join(f.lokiPaths(), ","); got != "/loki/api/v1/index/stats" {
		t.Fatalf("read past the estimate: %s", got)
	}
	if res.StoreQueries != 4 {
		t.Fatalf("%d store queries: the two reads not made go back", res.StoreQueries)
	}
	var after map[string]interface{}
	_ = json.Unmarshal(f.audit.rows[0].After, &after)
	if f.audit.rows[0].Action != "k8s.pod.logs.logql" || after["estimated_bytes"] != float64(2048) {
		t.Fatalf("row %+v", f.audit.rows[0])
	}
}

// oneLineRead is the read the log checks make when the index counts no line: a log query of one line over both windows.
func oneLineRead(t *testing.T, f *storeFixture) *http.Request {
	t.Helper()
	var got []*http.Request
	for _, r := range f.lokiReqs() {
		if r.URL.Path == "/loki/api/v1/query_range" && r.URL.Query().Get("step") == "" {
			got = append(got, r)
		}
	}
	if len(got) != 1 {
		t.Fatalf("%d one-line reads: %v", len(got), f.lokiPaths())
	}
	q := got[0].URL.Query()
	if q.Get("limit") != "1" || q.Get("start") != fmt.Sprint(unixAt(23-24, 30)*1e9) || q.Get("end") != fmt.Sprint(unixAt(1, 30)*1e9) ||
		!strings.Contains(q.Get("query"), `k8s_cluster_name="kubeast", k8s_namespace_name="shop"`) || strings.Contains(q.Get("query"), "|") {
		t.Fatalf("the one-line read: %v", q)
	}
	return got[0]
}

func TestAnomaliesLogChecksReadALineWhenTheIndexCountsNone(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	// Loki's index without what its ingesters have not flushed: none, while the store answers a line
	f.stats = `{"streams":0,"chunks":0,"entries":0,"bytes":0}`
	f.lines = fmt.Sprintf(`{"status":"success","data":{"resultType":"streams","result":[
		{"stream":{"k8s_namespace_name":"shop","k8s_pod_name":"web-1","k8s_container_name":"app"},"values":[["%d","GET / 200"]]}]}}`, unixAt(1, 20)*1e9)
	res := f.get(t, "shop", podReader)
	notRun := notRunOf(res)
	for _, check := range anomaly.LogChecks {
		if why, ok := notRun[check]; ok {
			t.Errorf("%s not run: %q", check, why)
		}
	}
	found := map[string]bool{}
	for _, finding := range res.Findings {
		found[finding.Check+":"+finding.Target] = true
	}
	if !found[anomaly.CheckErrorLogShapes+`:level=error msg="dial tcp <_>: connection refused"`] || !found[anomaly.CheckErrorLogCounts+":container app"] {
		t.Fatalf("both log checks ran: %+v", res.Findings)
	}
	if got := f.lokiPaths(); len(got) != 4 || got[0] != "/loki/api/v1/index/stats" || got[1] != "/loki/api/v1/query_range" {
		t.Fatalf("the estimate, the one-line read, then the two reads: %v", got)
	}
	oneLineRead(t, f)
	if res.StoreQueries != 6 {
		t.Fatalf("%d store queries: the one-line read is made under the estimate's", res.StoreQueries)
	}
	var after map[string]interface{}
	_ = json.Unmarshal(f.audit.rows[0].After, &after)
	if effective, _ := after["effective"].([]interface{}); f.audit.rows[0].Action != "k8s.pod.logs.logql" || len(effective) != 4 {
		t.Fatalf("the row names the four queries sent: %v", after)
	}
	if strings.Contains(string(f.audit.rows[0].After), "GET / 200") {
		t.Fatalf("a row holds the line read: %s", f.audit.rows[0].After)
	}
}

func TestAnomaliesLogChecksWithNoLineInTheIndexOrTheStoreAreNotRun(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.stats = `{"streams":0,"chunks":0,"entries":0,"bytes":0}`
	res := f.get(t, "shop", podReader)
	notRun := notRunOf(res)
	for _, check := range anomaly.LogChecks {
		if !strings.HasPrefix(notRun[check], "the log store holds no lines for this namespace (or workload) in the window or the one before") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if got := strings.Join(f.lokiPaths(), ","); got != "/loki/api/v1/index/stats,/loki/api/v1/query_range" {
		t.Fatalf("the estimate and the one-line read only: %s", got)
	}
	oneLineRead(t, f)
	if res.StoreQueries != 4 {
		t.Fatalf("%d store queries: the two reads not made go back", res.StoreQueries)
	}

	// a one-line read that fails says so, and the two reads are not made
	f = newStoreFixture(t, config.Config{})
	f.stats = `{"streams":0,"chunks":0,"entries":0,"bytes":0}`
	f.lines = `not json`
	notRun = notRunOf(f.get(t, "shop", podReader))
	for _, check := range anomaly.LogChecks {
		if !strings.HasPrefix(notRun[check], "the log store: ") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if len(f.lokiReqs()) != 2 || f.audit.rows[0].Result != audit.ResultFailure {
		t.Fatalf("%v, row %+v", f.lokiPaths(), f.audit.rows[0])
	}
}

func TestAnomaliesStoreChecksFollowTheLogToolsDoor(t *testing.T) {
	objectsOnly := auth.TokenPayload{UserID: "u7", Email: "o@example.com", Perms: auth.PermissionMatrix{"*": {"resource.objects.read"}}}
	shellHolder := auth.TokenPayload{UserID: "u8", Email: "s@example.com", Perms: auth.PermissionMatrix{"*": {"resource.pod.read", "resource.node.shell"}}}
	cases := []struct {
		name      string
		namespace string
		payload   auth.TokenPayload
		canLogs   bool
		logs      string // the log checks' reason, "" = they ran
		traces    string
	}{
		{"a reader without resource.pod.read", "shop", objectsOnly, true, "reading logs needs resource.pod.read on this cluster", "reading traces needs resource.pod.read on this cluster"},
		{"a reader the cluster does not let read pod logs", "shop", podReader, false, "the cluster does not let you read pod logs in shop", "the cluster does not let you read pod logs in shop"},
		{"a pod reader in the node shell namespace", "kubeast-node-shell", podReader, true, "forbidden: namespace kubeast-node-shell runs ", ""},
		{"a node shell holder in the node shell namespace", "kubeast-node-shell", shellHolder, true, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newStoreFixture(t, config.Config{})
			f.canLogs = c.canLogs
			notRun := notRunOf(f.get(t, c.namespace, c.payload))
			for _, check := range anomaly.LogChecks {
				if got := notRun[check]; (c.logs == "") != (got == "") || !strings.HasPrefix(got, c.logs) {
					t.Errorf("%s: %q, want %q", check, got, c.logs)
				}
			}
			for _, check := range anomaly.TraceChecks {
				if got := notRun[check]; (c.traces == "") != (got == "") || !strings.HasPrefix(got, c.traces) {
					t.Errorf("%s: %q, want %q", check, got, c.traces)
				}
			}
			if c.logs != "" && len(f.lokiReqs()) != 0 {
				t.Errorf("the log store was read: %v", f.lokiPaths())
			}
			if c.traces != "" && len(f.tempoReqs()) != 0 {
				t.Errorf("the trace store was read %d times", len(f.tempoReqs()))
			}
			wantRows := 0
			if c.logs == "" {
				wantRows++
			}
			if c.traces == "" {
				wantRows++
			}
			if len(f.audit.rows) != wantRows {
				t.Errorf("%d audit rows, want %d", len(f.audit.rows), wantRows)
			}
		})
	}
}

// failingAudit takes no row while being asked to.
type failingAudit struct{ memAudit }

func (a *failingAudit) Write(context.Context, audit.Record) (int64, error) {
	return 0, errors.New("audit table refused the row")
}

func TestAnomaliesStoreChecksNeedTheAuditRow(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.h.auditStore = &downAudit{}
	notRun := notRunOf(f.get(t, "shop", podReader))
	for _, check := range append(append([]string{}, anomaly.LogChecks...), anomaly.TraceChecks...) {
		if !strings.HasPrefix(notRun[check], "the audit log cannot take a row now") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if f.reads() != 0 {
		t.Fatalf("read with no audit row to write")
	}

	// a row that cannot be written after the read leaves the answer out, and that answer is not kept
	f = newStoreFixture(t, config.Config{})
	f.h.auditStore = &failingAudit{}
	res := f.get(t, "shop", podReader)
	notRun = notRunOf(res)
	for _, check := range append(append([]string{}, anomaly.LogChecks...), anomaly.TraceChecks...) {
		if !strings.HasPrefix(notRun[check], "the audit log could not take this read's row") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	for _, finding := range res.Findings {
		if strings.HasPrefix(finding.Check, "error_log") || strings.HasPrefix(finding.Check, "trace_") {
			t.Errorf("a finding of an unrecorded read: %+v", finding)
		}
	}
	reads := f.reads()
	f.get(t, "shop", podReader)
	if f.reads() == reads {
		t.Fatal("an answer whose rows were not written was kept")
	}
}

func TestAnomaliesBudgetGoesInCheckOrder(t *testing.T) {
	f := newStoreFixture(t, config.Config{AnomalyRankMaxQueries: 4})
	f.h.anomalySrc = &fakeAnomalies{prometheus: true}
	res := f.get(t, "shop", flowReader)
	notRun := notRunOf(res)
	for _, check := range []string{anomaly.CheckCPUThrottling, anomaly.CheckErrorLogShapes, anomaly.CheckErrorLogCounts, anomaly.CheckTraceErrors, anomaly.CheckTraceLatency, anomaly.CheckTraceRequests} {
		if !strings.Contains(notRun[check], "store queries are spent") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if res.StoreQueries != 4 || f.reads() != 0 {
		t.Fatalf("%d store queries, %d store reads", res.StoreQueries, f.reads())
	}
}

func TestAnomaliesKeepToTheStoresRanges(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	w := httptest.NewRecorder()
	// 18 hours and the 18 before: past log search's 24 hours, within the trace store's 72
	f.h.GetNamespaceAnomalies(w, logSearchRequestAs("/api/v1/namespaces/shop/anomalies?start=2026-11-14T07:30:00Z", "self", "shop", podReader))
	var res anomaly.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	notRun := notRunOf(res)
	if !strings.Contains(notRun[anomaly.CheckErrorLogShapes], "features.logSearch.maxRange 24h0m0s") || notRun[anomaly.CheckTraceErrors] != "" || len(f.lokiReqs()) != 0 {
		t.Fatalf("%d %+v", w.Code, notRun)
	}
}

func TestAnomaliesWithoutTraceMetricsSayWhy(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.tempoOff = true
	notRun := notRunOf(f.get(t, "shop", podReader))
	for _, check := range anomaly.TraceChecks {
		if !strings.HasPrefix(notRun[check], "the trace store does not serve TraceQL metrics") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if f.audit.rows[1].Result != audit.ResultFailure {
		t.Fatalf("the failed trace read's row: %+v", f.audit.rows[1])
	}
}
