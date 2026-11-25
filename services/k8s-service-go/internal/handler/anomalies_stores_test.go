package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
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
	// services and containers, when set, are how many series Tempo and Loki's count query answer: all steady in both
	// windows but the last, whose failed spans or error lines appear
	services   int
	containers int
	// noBefore: no shape and no error line of the window before; noErrorsBefore: no error line of it, the shapes as they
	// are; noLines: no shape and no error line at all
	noBefore, noErrorsBefore, noLines bool
	// errorLines, when set, are each container's error lines (unix seconds), in place of those above
	errorLines map[string][]int64
	// fresh: the first of those services has no span in the window before
	fresh bool
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

// errorLines are error lines of the window before (00:20) and of the window (01:20).
func errorLines(before, now int) []int64 {
	return append(slices.Repeat([]int64{unixAt(0, 20)}, before), slices.Repeat([]int64{unixAt(1, 20)}, now)...)
}

var countedRange = regexp.MustCompile(`\[(\d+)s\](?: offset (\d+)s)?\)`)

// countedLines are the series Loki's query frontend answers r's error line count with: it moves the range's bounds out
// to multiples of the step, and each point has the lines of the query's range that ends its offset before it.
func countedLines(t *testing.T, r *http.Request, lines map[string][]int64) string {
	q := r.URL.Query()
	read := func(s string) int64 {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			t.Errorf("the error line count %v: %v", q, err)
		}
		return n
	}
	m := countedRange.FindStringSubmatch(q.Get("query"))
	if m == nil {
		t.Errorf("no range in the error line count %s", q.Get("query"))
		return ""
	}
	length, offset, step := read(m[1]), int64(0), read(q.Get("step"))
	if m[2] != "" {
		offset = read(m[2])
	}
	start, end := read(q.Get("start"))/1e9, read(q.Get("end"))/1e9
	start, end = start/step*step, (end+step-1)/step*step
	containers := make([]string, 0, len(lines))
	for c := range lines {
		containers = append(containers, c)
	}
	slices.Sort(containers)
	var series []string
	for _, c := range containers {
		var values []string
		for at := start; at <= end; at += step {
			n := 0
			for _, l := range lines[c] {
				if l > at-offset-length && l <= at-offset {
					n++
				}
			}
			if n > 0 {
				values = append(values, fmt.Sprintf(`[%d,"%d"]`, at, n))
			}
		}
		if len(values) > 0 {
			series = append(series, fmt.Sprintf(`{"metric":{"k8s_container_name":%q},"values":[%s]}`, c, strings.Join(values, ",")))
		}
	}
	return strings.Join(series, ",")
}

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
			if f.noLines {
				_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
				return
			}
			if f.noBefore {
				_, _ = fmt.Fprintf(w, `{"status":"success","data":[{"pattern":"GET /healthz <_>","level":"info","samples":[[%d,40]]}]}`, unixAt(1, 0))
				return
			}
			_, _ = fmt.Fprintf(w, `{"status":"success","data":[
				{"pattern":"level=error msg=\"dial tcp <_>: connection refused\"","level":"error","samples":[[%d,6],[%d,6]]},
				{"pattern":"GET /healthz <_>","level":"info","samples":[[%d,40],[%d,40]]}]}`,
				unixAt(0, 40), unixAt(1, 0), unixAt(0, 0), unixAt(1, 0))
		case "/loki/api/v1/query_range":
			if r.URL.Query().Get("step") == "" {
				_, _ = w.Write([]byte(f.lines))
				return
			}
			f.mu.Lock()
			containers := f.containers
			f.mu.Unlock()
			lines := map[string][]int64{}
			switch {
			case f.errorLines != nil:
				lines = f.errorLines
			case f.noLines:
			case f.noBefore || f.noErrorsBefore:
				lines["app"] = errorLines(0, 9)
			case containers > 0:
				for i := 0; i < containers; i++ {
					lines[fmt.Sprintf("c%03d", i)] = errorLines(2, 2)
				}
				lines[fmt.Sprintf("c%03d", containers-1)] = errorLines(0, 9)
			default:
				lines["app"], lines["sidecar"] = errorLines(2, 9), errorLines(4, 5)
			}
			_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"matrix","result":[%s]}}`, countedLines(t, r, lines))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(loki.Close)
	tempo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.tempo = append(f.tempo, r)
		off, services := f.tempoOff, f.services
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
		stepsOf := func(before, now float64) string {
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
			return strings.Join(samples, ",")
		}
		if services == 0 {
			_, _ = fmt.Fprintf(w, `{"series":[{"labels":[{"key":"resource.service.name","value":{"stringValue":"cart"}}],"samples":[%s]}]}`, stepsOf(before, now))
			return
		}
		series := make([]string, 0, services)
		for i := 0; i < services; i++ {
			b, n := 100.0, 100.0
			switch {
			case strings.Contains(q, "status = error"):
				b, n = 0, 0
				if i == services-1 {
					n = 10
				}
			case strings.Contains(q, "quantile_over_time"):
				b, n = 0.05, 0.05
			}
			if f.fresh && i == 0 {
				b = 0
			}
			series = append(series, fmt.Sprintf(`{"labels":[{"key":"resource.service.name","value":{"stringValue":"svc-%03d"}}],"samples":[%s]}`, i, stepsOf(b, n)))
		}
		_, _ = fmt.Fprintf(w, `{"series":[%s]}`, strings.Join(series, ","))
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
	if res.StoreQueries != 7 {
		t.Fatalf("%d store queries: the one-line read is one of them", res.StoreQueries)
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
	if res.StoreQueries != 5 {
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
	f := newStoreFixture(t, config.Config{AnomalyRankMaxQueries: 2})
	f.h.anomalySrc = &fakeAnomalies{prometheus: true}
	res := f.get(t, "shop", flowReader)
	notRun := notRunOf(res)
	for _, check := range []string{anomaly.CheckCPUThrottling, anomaly.CheckErrorLogShapes, anomaly.CheckErrorLogCounts, anomaly.CheckTraceErrors, anomaly.CheckTraceLatency, anomaly.CheckTraceRequests} {
		if !strings.Contains(notRun[check], "store queries are spent") {
			t.Errorf("%s: %q", check, notRun[check])
		}
	}
	if res.StoreQueries != 2 || f.reads() != 0 {
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

// readOf asks for the narrowing and gives its findings' targets, its normal checks and its partial checks with why, as
// the answer's JSON says them.
func (f *storeFixture) readOf(t *testing.T, namespace string) ([]string, []string, map[string]string) {
	t.Helper()
	w := httptest.NewRecorder()
	f.h.GetNamespaceAnomalies(w, logSearchRequestAs("/api/v1/namespaces/"+namespace+"/anomalies", "self", namespace, podReader))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var res struct {
		Findings []anomaly.Finding `json:"findings"`
		Normal   []string          `json:"normal"`
		Partial  []anomaly.NotRun  `json:"partial"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	targets := []string{}
	for _, finding := range res.Findings {
		targets = append(targets, finding.Check+":"+finding.Target)
	}
	partial := map[string]string{}
	for _, p := range res.Partial {
		partial[p.Check] = p.Reason
	}
	return targets, res.Normal, partial
}

// Tempo answers 101 services, the first 100 steady in both windows and the 101st with failed spans that appear: past
// the reader's 100 series, the trace checks say they read the first 100, so their normal is about those.
func TestAnomaliesPastTheTraceReadersSeriesArePartial(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.services = traces.MaxSeries + 1
	found, normal, partial := f.readOf(t, "shop")
	for _, target := range found {
		if strings.HasPrefix(target, "trace_") {
			t.Errorf("a trace finding among steady services: %s", target)
		}
	}
	for _, check := range anomaly.TraceChecks {
		if !strings.Contains(partial[check], "answered 101 series and only the first 100 were read") {
			t.Errorf("%s: partial %q", check, partial[check])
		}
	}
	// the failed share needs the requests: a service past the requests read is not compared even when its failures are read
	if !strings.Contains(partial[anomaly.CheckTraceErrors], "the trace store's requests query") || !slices.Contains(normal, anomaly.CheckTraceErrors) {
		t.Fatalf("normal %v partial %v", normal, partial)
	}
}

// A service with no span in the window before beside others that have them: the latency check says it was not compared,
// beside what else it did not read, and the service's requests are new.
func TestAnomaliesSayWhichServiceWasNotCompared(t *testing.T) {
	const alone = "not compared, no server spans in the window before: service svc-000"
	f := newStoreFixture(t, config.Config{})
	f.services, f.fresh = 3, true
	found, normal, partial := f.readOf(t, "shop")
	if partial[anomaly.CheckTraceLatency] != alone || !slices.Contains(normal, anomaly.CheckTraceLatency) || !slices.Contains(found, anomaly.CheckTraceRequests+":service svc-000") {
		t.Fatalf("found %v normal %v partial %v", found, normal, partial)
	}
	f = newStoreFixture(t, config.Config{})
	f.services, f.fresh = traces.MaxSeries+1, true
	if _, _, partial = f.readOf(t, "shop"); partial[anomaly.CheckTraceLatency] != alone+"; the trace store's latency query answered 101 series and only the first 100 were read; the check is about those" {
		t.Fatalf("partial %q", partial[anomaly.CheckTraceLatency])
	}
}

// Whatever its bounds, the error lines are those of the window and of the window before, to the second: Loki answers at
// multiples of the step, which a window's bounds seldom are.
func TestAnomaliesCountErrorLinesOnTheWindowsBounds(t *testing.T) {
	day := func(h, m, s int) time.Time { return time.Date(2026, 11, 15, h, m, s, 0, time.UTC) }
	for name, win := range map[string]anomaly.Window{
		"the hour before now":            {Start: day(0, 30, 0), End: day(1, 30, 0)},
		"an hour on the hour":            {Start: day(0, 0, 0), End: day(1, 0, 0)},
		"an hour that ends on a second":  {Start: day(0, 29, 19), End: day(1, 29, 19)},
		"five minutes":                   {Start: day(1, 22, 0), End: day(1, 27, 0)},
		"1201 seconds":                   {Start: day(1, 9, 59), End: day(1, 30, 0)},
		"across midnight":                {Start: day(-2, 17, 0), End: day(0, 43, 0)},
		"an hour that ends at half past": {Start: day(-1, 30, 0), End: day(0, 30, 0)},
	} {
		t.Run(name, func(t *testing.T) {
			f := newStoreFixture(t, config.Config{})
			start, end, length := win.Start.Unix(), win.End.Unix(), int64(win.Length()/time.Second)
			f.errorLines = map[string][]int64{
				// two lines in the window before and nine in the window, its ends among them; one on each side of both
				"app": append([]int64{start - length, start - length + 1, start, end + 1}, slices.Repeat([]int64{start + 1, end - 1, end}, 3)...),
			}
			w := httptest.NewRecorder()
			f.h.GetNamespaceAnomalies(w, logSearchRequestAs("/api/v1/namespaces/shop/anomalies?start="+win.Start.Format(time.RFC3339)+"&end="+win.End.Format(time.RFC3339), "self", "shop", podReader))
			var res anomaly.Result
			if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || w.Code != http.StatusOK {
				t.Fatalf("%d %s %v", w.Code, w.Body, err)
			}
			c := logCountOf(t, res)
			if c.Target != "container app" || c.Verdict != anomaly.VerdictAnomalous || *c.Now != 9 || c.Before == nil || *c.Before != 2 {
				t.Fatalf("%+v", c)
			}
			counts := 0
			for _, r := range f.lokiReqs() {
				if r.URL.Query().Get("step") != "" {
					counts++
				}
			}
			if counts != 1 {
				t.Fatalf("%d count queries", counts)
			}
		})
	}
}

// Loki's count query answers 101 containers, the first 100 steady and the 101st with error lines that appear: the
// count check says it read the first 100; the shapes, read whole, are not partial.
func TestAnomaliesPastTheLogReadersSeriesArePartial(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.containers = logsearch.MaxSeries + 1
	found, normal, partial := f.readOf(t, "shop")
	for _, target := range found {
		if strings.HasPrefix(target, anomaly.CheckErrorLogCounts) {
			t.Errorf("a count finding among steady containers: %s", target)
		}
	}
	if !strings.HasPrefix(partial[anomaly.CheckErrorLogCounts], "the log store answered 101 series and only the first 100 were read") || !slices.Contains(normal, anomaly.CheckErrorLogCounts) {
		t.Fatalf("normal %v partial %v", normal, partial)
	}
	if why, ok := partial[anomaly.CheckErrorLogShapes]; ok {
		t.Fatalf("the shapes: %q", why)
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
