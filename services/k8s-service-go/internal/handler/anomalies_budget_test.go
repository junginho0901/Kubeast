package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/anomaly"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// threeStores is a namespace whose Prometheus, log store and trace store all answer with rows, and whose findings name
// two workloads of a graph, so that the call order is asked.
func threeStores(t *testing.T, cfg config.Config) (*storeFixture, *twoRestarting, *fixedCalls) {
	t.Helper()
	f := newStoreFixture(t, cfg)
	src, calls := &twoRestarting{}, &fixedCalls{fakeCalls: callsSource()}
	f.h.anomalySrc, f.h.netdropsSrc = src, calls
	f.h.anomalyGraph = func(context.Context, string) (map[string]interface{}, error) { return orderGraph, nil }
	return f, src, calls
}

// storeReadsOf counts what one answer read of each store: the metric checks', the log store's, the trace store's and
// the call order's.
func storeReadsOf(f *storeFixture, src *twoRestarting, calls *fixedCalls) (metrics, logs, spans, order int) {
	src.mu.Lock()
	metrics = src.reads
	src.mu.Unlock()
	calls.mu.Lock()
	order = len(calls.at) + len(calls.between) + calls.plain
	calls.mu.Unlock()
	return metrics, len(f.lokiReqs()), len(f.tempoReqs()), order
}

// With every store answering rows, every check and the call order run within the default store queries: three metric
// checks, three reads of the log store, three of the trace store and the call graph's three.
func TestAnomaliesCallOrderRunsWhenEveryStoreHasData(t *testing.T) {
	f, src, calls := threeStores(t, config.Config{CallGraphEnabled: true})
	res := f.get(t, "shop", flowReader)
	metrics, logs, spans, order := storeReadsOf(f, src, calls)
	if metrics != 3 || logs != 3 || spans != 3 || order != 3 || res.StoreQueries != 12 {
		t.Fatalf("read %d metric, %d log, %d trace and %d call graph queries, %d counted", metrics, logs, spans, order, res.StoreQueries)
	}
	for check, why := range notRunOf(res) {
		if strings.Contains(why, budgetSpent) {
			t.Errorf("%s was left out: %s", check, why)
		}
	}
	co := res.CallOrder
	if co == nil || !co.Applied || len(co.Suspects) == 0 || co.Suspects[0] != "Deployment/shop/api" || co.Moved != 2 || co.Reason != "" {
		t.Fatalf("call_order %+v", co)
	}
	// the log and trace rows are in the answer too
	found := map[string]bool{}
	for _, finding := range res.Findings {
		found[finding.Check] = true
	}
	for _, check := range []string{anomaly.CheckErrorLogShapes, anomaly.CheckErrorLogCounts, anomaly.CheckTraceErrors, anomaly.CheckTraceLatency, anomaly.CheckRestarts} {
		if !found[check] {
			t.Errorf("no finding of %s: %+v", check, res.Findings)
		}
	}

	// off, the same checks run and the queries the call order kept are not spent
	f, src, calls = threeStores(t, config.Config{})
	off := f.get(t, "shop", flowReader)
	metrics, logs, spans, order = storeReadsOf(f, src, calls)
	if metrics != 3 || logs != 3 || spans != 3 || order != 0 || off.StoreQueries != 9 || off.CallOrder != nil {
		t.Fatalf("off: read %d, %d, %d and %d, %d counted, call_order %+v", metrics, logs, spans, order, off.StoreQueries, off.CallOrder)
	}
	if a, b := checksOf(res), checksOf(off); a != b {
		t.Fatalf("the checks with the call graph on and off:\n%s\n%s", a, b)
	}
}

// checksOf says which check is in which list of the answer.
func checksOf(res anomaly.Result) string {
	var out []string
	seen := map[string]bool{}
	for _, f := range res.Findings {
		if !seen[f.Check] {
			seen[f.Check] = true
			out = append(out, f.Check+":found")
		}
	}
	for _, c := range res.Normal {
		out = append(out, c+":normal")
	}
	for _, n := range res.NotRun {
		out = append(out, n.Check+":not_run")
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// emptyIndex is an index that counts no line, as Loki's does of lines its ingesters have not flushed, over a store that
// answers a read of one line with lines.
func emptyIndex(f *storeFixture, lines string) {
	f.stats = `{"streams":0,"chunks":0,"entries":0,"bytes":0}`
	f.lines = lines
}

// oneLine is the answer of a read of one line that finds one; noLine of one that finds none.
var (
	oneLine = fmt.Sprintf(`{"status":"success","data":{"resultType":"streams","result":[
		{"stream":{"k8s_namespace_name":"shop","k8s_pod_name":"web-1","k8s_container_name":"app"},"values":[["%d","GET / 200"]]}]}}`, unixAt(0, 10)*1e9)
	noLine = `{"status":"success","data":{"resultType":"streams","result":[]}}`
)

// Whatever maxQueries is and whatever the stores hold, an answer makes no more store queries than it and counts those it
// made; the call order runs from the default on.
func TestAnomaliesNeverPassTheirStoreQueries(t *testing.T) {
	for name, set := range map[string]func(*storeFixture){
		"lines in both windows":                      func(*storeFixture) {},
		"none in the window before":                  func(f *storeFixture) { f.noBefore = true },
		"an empty index":                             func(f *storeFixture) { emptyIndex(f, oneLine) },
		"an empty index and none before":             func(f *storeFixture) { emptyIndex(f, oneLine); f.noBefore = true },
		"an empty index and no line":                 func(f *storeFixture) { emptyIndex(f, noLine) },
		"an empty index, no line, shapes or counts":  func(f *storeFixture) { emptyIndex(f, noLine); f.noLines = true },
		"an empty index and a one-line read failing": func(f *storeFixture) { emptyIndex(f, "not json") },
	} {
		for _, on := range []bool{false, true} {
			for limit := 1; limit <= 16; limit++ {
				f, src, calls := threeStores(t, config.Config{CallGraphEnabled: on, AnomalyRankMaxQueries: limit})
				set(f)
				res := f.get(t, "shop", flowReader)
				metrics, logs, spans, order := storeReadsOf(f, src, calls)
				made := metrics + logs + spans + order
				if made != res.StoreQueries || made > limit {
					t.Errorf("%s, maxQueries %d, call graph %v: %d made (%d, %d, %d, %d), %d counted", name, limit, on, made, metrics, logs, spans, order, res.StoreQueries)
				}
				applied := res.CallOrder != nil && res.CallOrder.Applied
				if on && limit >= 12 && !applied {
					t.Errorf("%s, maxQueries %d: call_order %+v", name, limit, res.CallOrder)
				}
				if !on && res.CallOrder != nil {
					t.Errorf("%s, maxQueries %d: call_order with the call graph off", name, limit)
				}
			}
		}
	}
	for queries, want := range map[int]int{1: 0, 11: 0, 12: 3, 13: 3, 40: 3} {
		if got := callOrderShare(queries); got != want {
			t.Errorf("share of %d: %d", queries, got)
		}
	}
}

func logCountOf(t *testing.T, res anomaly.Result) anomaly.Finding {
	t.Helper()
	for _, f := range res.Findings {
		if f.Check == anomaly.CheckErrorLogCounts {
			return f
		}
	}
	t.Fatalf("no error line finding: %+v", res.Findings)
	return anomaly.Finding{}
}

// Error lines with none in the window before, and no shape of it either: one line of that window, read when the queries
// leave room, says whether they are new or there is no earlier data.
func TestAnomaliesErrorLinesAreNewOnlyWithALineOfTheWindowBefore(t *testing.T) {
	for _, c := range []struct {
		name, lines, summary string
		isNew                bool
		row                  string
	}{
		{"a line there", oneLine, "9 lines matching (?i)(error|exception|fatal|panic) in the window, 0 in the window before", true, audit.ResultSuccess},
		{"none there", "", "9 lines matching (?i)(error|exception|fatal|panic) in the window, no earlier data", false, audit.ResultSuccess},
		{"the read failed", "not json", "9 lines matching (?i)(error|exception|fatal|panic) in the window, 0 in the window before (whether the log store holds earlier lines was not checked)", false, audit.ResultFailure},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newStoreFixture(t, config.Config{})
			f.noBefore = true
			if c.lines != "" {
				f.lines = c.lines
			}
			res := f.get(t, "shop", podReader)
			if got := logCountOf(t, res); got.New != c.isNew || (got.Before != nil) != c.isNew || got.Summary != c.summary || got.Verdict != anomaly.VerdictAnomalous {
				t.Fatalf("%+v", got)
			}
			// the estimate, the shapes and the counts, then one line of the window before, kept to the namespace
			var one []*http.Request
			for _, r := range f.lokiReqs() {
				if r.URL.Path == "/loki/api/v1/query_range" && r.URL.Query().Get("step") == "" {
					one = append(one, r)
				}
			}
			if len(one) != 1 || len(f.lokiReqs()) != 4 || res.StoreQueries != 7 {
				t.Fatalf("%d one-line reads of %v, %d store queries", len(one), f.lokiPaths(), res.StoreQueries)
			}
			q := one[0].URL.Query()
			if q.Get("limit") != "1" || q.Get("start") != fmt.Sprint(unixAt(23-24, 30)*1e9) || q.Get("end") != fmt.Sprint(unixAt(0, 30)*1e9) ||
				!strings.Contains(q.Get("query"), `k8s_cluster_name="kubeast", k8s_namespace_name="shop"`) {
				t.Fatalf("the one-line read: %v", q)
			}
			var after map[string]interface{}
			_ = json.Unmarshal(f.audit.rows[0].After, &after)
			if effective, _ := after["effective"].([]interface{}); f.audit.rows[0].Action != "k8s.pod.logs.logql" || len(effective) != 4 || f.audit.rows[0].Result != c.row {
				t.Fatalf("the row names the four queries sent: %+v %v", f.audit.rows[0], after)
			}
			if strings.Contains(string(f.audit.rows[0].After), "GET / 200") {
				t.Fatalf("a row holds the line read: %s", f.audit.rows[0].After)
			}
		})
	}

	// nothing to decide: no read of a line, and the query set aside for it goes back
	f := newStoreFixture(t, config.Config{})
	if res := f.get(t, "shop", podReader); len(f.lokiReqs()) != 3 || res.StoreQueries != 6 {
		t.Fatalf("%v, %d store queries", f.lokiPaths(), res.StoreQueries)
	}
}

// A shape of the window before, of any level, says the store holds lines of it: error lines are then new with no read of a
// line, also when no query is left for one.
func TestAnomaliesAShapeOfTheWindowBeforeSaysThereAreLinesOfIt(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	f.noErrorsBefore = true
	f.lines = "not json"
	res := f.get(t, "shop", podReader)
	if got := logCountOf(t, res); !got.New || got.Before == nil || *got.Before != 0 || !strings.HasSuffix(got.Summary, "9 lines matching (?i)(error|exception|fatal|panic) in the window, 0 in the window before") {
		t.Fatalf("%+v", got)
	}
	if len(f.lokiReqs()) != 3 || res.StoreQueries != 6 {
		t.Fatalf("%v, %d store queries", f.lokiPaths(), res.StoreQueries)
	}
	three, _, _ := threeStores(t, config.Config{CallGraphEnabled: true})
	three.noErrorsBefore = true
	if got := logCountOf(t, three.get(t, "shop", flowReader)); !got.New {
		t.Fatalf("with no query left: %+v", got)
	}
}

// An index that counts no line: a read of one line over both windows and, for error lines with none in the window before,
// one over that window are each a store query.
func TestAnomaliesEveryReadOfALineIsAStoreQuery(t *testing.T) {
	f := newStoreFixture(t, config.Config{})
	emptyIndex(f, oneLine)
	f.noBefore = true
	res := f.get(t, "shop", podReader)
	if len(f.lokiReqs()) != 5 || len(f.tempoReqs()) != 3 || res.StoreQueries != 8 {
		t.Fatalf("%v and %d trace queries, %d store queries", f.lokiPaths(), len(f.tempoReqs()), res.StoreQueries)
	}
	if got := logCountOf(t, res); !got.New {
		t.Fatalf("%+v", got)
	}
}

// An index that counts no line and no query left to read one: the shapes and counts are read all the same, and a store
// that shows no line then is not normal.
func TestAnomaliesAnEmptyIndexWithNoQueryLeft(t *testing.T) {
	f, src, calls := threeStores(t, config.Config{CallGraphEnabled: true})
	emptyIndex(f, "not json")
	res := f.get(t, "shop", flowReader)
	metrics, logs, spans, order := storeReadsOf(f, src, calls)
	if metrics != 3 || logs != 3 || spans != 3 || order != 3 || res.StoreQueries != 12 || res.CallOrder == nil || !res.CallOrder.Applied {
		t.Fatalf("%d, %d, %d and %d, %d counted, call_order %+v", metrics, logs, spans, order, res.StoreQueries, res.CallOrder)
	}
	if got := logCountOf(t, res); got.Target != "container app" || got.Verdict != anomaly.VerdictAnomalous {
		t.Fatalf("%+v", got)
	}

	f, _, _ = threeStores(t, config.Config{CallGraphEnabled: true})
	emptyIndex(f, "not json")
	f.noLines = true
	res = f.get(t, "shop", flowReader)
	notRun := notRunOf(res)
	if notRun[anomaly.CheckErrorLogCounts] != anomaly.NoLinesSeen || notRun[anomaly.CheckErrorLogShapes] != anomaly.NoPatterns {
		t.Fatalf("normal %v, not run %v", res.Normal, notRun)
	}

	// lines the index counts, none of them an error line, are normal
	f, _, _ = threeStores(t, config.Config{CallGraphEnabled: true})
	f.noLines = true
	if res = f.get(t, "shop", flowReader); !slices.Contains(res.Normal, anomaly.CheckErrorLogCounts) {
		t.Fatalf("normal %v, not run %v", res.Normal, res.NotRun)
	}
	// and so is a line the index does not count and a read of one line finds, with a query left for it
	f = newStoreFixture(t, config.Config{})
	emptyIndex(f, oneLine)
	f.noLines = true
	if res = f.get(t, "shop", podReader); !slices.Contains(res.Normal, anomaly.CheckErrorLogCounts) || len(f.lokiReqs()) != 4 || res.StoreQueries != 7 {
		t.Fatalf("normal %v, not run %v, %v, %d store queries", res.Normal, res.NotRun, f.lokiPaths(), res.StoreQueries)
	}
}

// The call order keeps its queries from the log checks' read of one line; one query more than the default makes room.
func TestAnomaliesTheCallOrdersShareIsNotTheLogChecks(t *testing.T) {
	for limit, read := range map[int]bool{12: false, 13: true} {
		f, _, _ := threeStores(t, config.Config{CallGraphEnabled: true, AnomalyRankMaxQueries: limit})
		f.noBefore = true
		res := f.get(t, "shop", flowReader)
		if res.CallOrder == nil || !res.CallOrder.Applied || res.StoreQueries != limit {
			t.Fatalf("maxQueries %d: call_order %+v, %d store queries", limit, res.CallOrder, res.StoreQueries)
		}
		got := logCountOf(t, res)
		if got.New || (len(f.lokiReqs()) == 4) != read || strings.Contains(got.Summary, "was not checked") == read || strings.Contains(got.Summary, anomaly.NoEarlier) != read {
			t.Errorf("maxQueries %d: %+v, %v", limit, got, f.lokiPaths())
		}
	}
}

// nothingReads is a cluster that answers none of the narrowing's reads.
type nothingReads struct {
	fakeAnomalies
	issuesErr, podsErr error
}

func (n *nothingReads) CollectIssues(context.Context, k8s.IssuesOptions) ([]k8s.Issue, error) {
	return []k8s.Issue{{Kind: "Collector", Name: "nodes", Severity: "info", Reason: "ListFailed", Message: "nodes is forbidden"},
		{Kind: "Collector", Name: "jobs", Severity: "info", Reason: "ListFailed"}}, n.issuesErr
}

func (n *nothingReads) EachPodRow(context.Context, string, string, func(map[string]interface{})) error {
	return n.podsErr
}

// Each check that could not run is named once, with why, and none of them is normal.
func TestAnomaliesNameEveryCheckThatCouldNotRun(t *testing.T) {
	for name, n := range map[string]*nothingReads{
		"nothing to read":  {},
		"no issue check":   {issuesErr: errors.New("the cluster is gone")},
		"no pod list":      {podsErr: errors.New("pods is forbidden")},
		"a pod list late":  {podsErr: context.DeadlineExceeded},
		"neither of those": {issuesErr: errors.New("the cluster is gone"), podsErr: errors.New("pods is forbidden")},
	} {
		h := &Handler{cfg: config.Config{AnomalyRankEnabled: true}, anomalySrc: n, anomalyNow: func() time.Time { return anomalyNow }}
		_, res := getAnomalies(h, "/api/v1/namespaces/shop/anomalies", flowReader)
		if len(res.Findings) != 0 || len(res.Normal) != 0 {
			t.Errorf("%s: %+v", name, res)
		}
		var named []string
		for _, c := range res.NotRun {
			named = append(named, c.Check)
			if len(strings.Fields(c.Reason)) < 3 {
				t.Errorf("%s: %s is not run because %q", name, c.Check, c.Reason)
			}
		}
		want := slices.Clone(anomaly.Checks)
		sort.Strings(named)
		sort.Strings(want)
		if strings.Join(named, ",") != strings.Join(want, ",") {
			t.Errorf("%s: not run %v", name, named)
		}
	}
}
