package eval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/model"
)

const casesDir = "../../../../evals/dashboards"

func loadCase(t *testing.T, id string) (Case, []byte) {
	t.Helper()
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if c.ID == id {
			return c, c.Reference
		}
	}
	t.Fatalf("no case %s", id)
	return Case{}, nil
}

// Every reference answer passes the checks that need no store (they also
// returned data on the dev cluster's stores — see the README).
func TestReferencesPass(t *testing.T) {
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) != 30 {
		t.Fatalf("%d cases, want 30", len(cases))
	}
	kinds := map[string]int{}
	for _, c := range cases {
		kinds[c.Kind]++
		r := Grade(context.Background(), c, c.Reference, Stores{})
		if !r.Pass {
			t.Errorf("%s: reference fails %+v", c.ID, r.Failed())
		}
	}
	if kinds[KindBuild] == 0 || kinds[KindEdit] == 0 || kinds[KindDecline] == 0 {
		t.Errorf("kinds %v, want each", kinds)
	}
}

// failsOn grades answer and wants the check named failing among the failures.
func failsOn(t *testing.T, c Case, answer []byte, s Stores, failing string) Result {
	t.Helper()
	r := Grade(context.Background(), c, answer, s)
	if r.Pass {
		t.Fatalf("passed: %+v", r.Checks)
	}
	for _, f := range r.Failed() {
		if f.Name == failing {
			return r
		}
	}
	t.Fatalf("want %q among the failures, got %+v", failing, r.Failed())
	return r
}

// check finds a check by name.
func check(r Result, name string) *Check {
	for i := range r.Checks {
		if r.Checks[i].Name == name {
			return &r.Checks[i]
		}
	}
	return nil
}

// edit changes the reference as a builder might get it wrong.
func edit(t *testing.T, ref []byte, fn func(d map[string]any)) []byte {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal(ref, &d); err != nil {
		t.Fatal(err)
	}
	fn(d)
	b, _ := json.Marshal(d)
	return b
}

func panels(d map[string]any) map[string]any {
	return d["spec"].(map[string]any)["panels"].(map[string]any)
}

func expr(d map[string]any, panel string) map[string]any {
	return panels(d)[panel].(map[string]any)["queries"].([]any)[0].(map[string]any)
}

func replaceExpr(old, new string) func(map[string]any) {
	return func(d map[string]any) {
		for _, p := range panels(d) {
			for _, q := range p.(map[string]any)["queries"].([]any) {
				qm := q.(map[string]any)
				qm["expr"] = strings.ReplaceAll(qm["expr"].(string), old, new)
			}
		}
	}
}

func dropPanels(names ...string) func(map[string]any) {
	return func(d map[string]any) {
		layout := d["spec"].(map[string]any)["layout"].(map[string]any)
		var items []any
		for _, it := range layout["items"].([]any) {
			if !slices.Contains(names, it.(map[string]any)["panel"].(string)) {
				items = append(items, it)
			}
		}
		layout["items"] = items
		for _, n := range names {
			delete(panels(d), n)
		}
	}
}

func setKind(panel, kind string) func(map[string]any) {
	return func(d map[string]any) { panels(d)[panel].(map[string]any)["kind"] = kind }
}

// Each wrong answer fails the check named for it.
func TestCatchesWrongAnswers(t *testing.T) {
	cases := []struct {
		name, caseID, failing string
		fn                    func(map[string]any)
	}{
		{"unknown field", "01_namespace_resources", "document", func(d map[string]any) { d["colour"] = "red" }},
		{"invalid layout", "01_namespace_resources", "document", func(d map[string]any) {
			d["spec"].(map[string]any)["layout"].(map[string]any)["items"].([]any)[0].(map[string]any)["w"] = 30
		}},
		{"wrong metric", "01_namespace_resources", "asked for: CPU 사용량", replaceExpr("container_cpu_usage_seconds_total", "container_cpu_user_seconds_total")},
		{"counter without rate", "09_network_by_namespace", "counters read as rates", replaceExpr("rate(container_network_receive_bytes_total[$__rate_interval])", "container_network_receive_bytes_total")},
		{"namespace dropped", "01_namespace_resources", "kept to namespace=kube-system", replaceExpr(`namespace="$namespace", `, "")},
		{"namespace as .*", "01_namespace_resources", "kept to namespace=kube-system", replaceExpr(`namespace="$namespace"`, `namespace=~".*"`)},
		{"cluster matcher", "07_pod_phase", "no cluster matcher (the server adds it)", replaceExpr("kube_pod_status_phase)", `kube_pod_status_phase{cluster="$cluster"})`)},
		{"PromQL broken", "03_pod_restarts", "PromQL parses", replaceExpr("increase(", "increase((")},
		{"panel without query", "04_deployment_replicas", "every panel has a query", func(d map[string]any) {
			panels(d)["missing"].(map[string]any)["queries"] = []any{}
		}},
		{"memory in the wrong unit", "01_namespace_resources", "asked for: 메모리 사용량", func(d map[string]any) {
			for _, k := range []string{"mem-total", "mem-by-pod"} {
				panels(d)[k].(map[string]any)["fieldDefaults"] = map[string]any{"unit": "short"}
			}
		}},
		{"too few panels", "02_node_overview", "panel count", dropPanels("mem-used", "disk-used", "net")},
		// ambiguous requests: fewer of the answers than asked for
		{"one of three", "11_cluster_health", "asked for 3 of: 노드 상태, 파드 상태, CPU, 메모리, 파드 재시작, 레플리카",
			dropPanels("nodes-not-ready", "restarts", "unavailable", "mem")},
		// LogQL and TraceQL
		{"Loki cluster matcher", "21_logs_namespace", "no cluster matcher (the server adds it)",
			replaceExpr(`{k8s_namespace_name="$namespace"}`, `{k8s_cluster_name="kubeast-b", k8s_namespace_name="$namespace"}`)},
		{"LogQL without a selector", "23_log_volume", "LogQL and TraceQL have a selector", replaceExpr(`{k8s_namespace_name=~".+"}`, ``)},
		{"log lines in a time series", "22_logs_errors", "query fits its panel", setKind("error-logs", "timeseries")},
		{"metric query in a logs panel", "22_logs_errors", "query fits its panel", setKind("errors-over-time", "logs")},
		{"error logs not filtered", "22_logs_errors", "asked for: 에러 로그", replaceExpr(` | logfmt | level="ERROR"`, ``)},
		{"logs selected by another label", "21_logs_namespace", "asked for: 로그", replaceExpr(`{k8s_namespace_name=`, `{namespace=`)},
		{"traces in a time series", "25_slow_traces", "query fits its panel", setKind("slow", "timeseries")},
		{"slow traces without duration", "25_slow_traces", "asked for: 느린 트레이스", replaceExpr(` && duration > 1s`, ``)},
		{"Tempo cluster matcher", "26_error_traces", "no cluster matcher (the server adds it)",
			replaceExpr(`resource.service.name = "kubeast-eval-shop"`, `resource.service.name = "kubeast-eval-shop" && resource.k8s.cluster.name = "kubeast-b"`)},
		{"route rate without by", "27_route_rate_traces", "asked for: 라우트별 요청 비율", replaceExpr(`| rate() by (span.http.route)`, `| rate()`)},
		// partial request: the part that is not there stays out
		{"GPU panel made up", "20_partial_gpu", "does not read DCGM_, nvidia_, gpu_, node_gpu, container_gpu, container_accelerator_, accelerator_",
			replaceExpr(`1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))`,
				`1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) + avg(DCGM_FI_DEV_GPU_UTIL)`)},
		// edits
		{"edit touched another panel", "28_edit_p99", "kept as it was: reqs", replaceExpr("sum by (handler)", "sum by (code)")},
		{"edit left the average", "28_edit_p99", "asked for: p99 응답 시간", func(d map[string]any) {
			expr(d, "latency")["expr"] = "sum(rate(prometheus_http_request_duration_seconds_sum[$__rate_interval])) / sum(rate(prometheus_http_request_duration_seconds_count[$__rate_interval]))"
		}},
		{"variable not added", "29_edit_add_variable", "has variable: namespace", func(d map[string]any) {
			delete(d["spec"].(map[string]any), "variables")
		}},
		{"variable not used", "29_edit_add_variable", "asked for: CPU 사용량", replaceExpr(`namespace="$namespace"`, `namespace="kube-system"`)},
		{"removed panel kept", "30_edit_remove_panel", "does not read node_network_", func(d map[string]any) {
			expr(d, "cpu-busy")["expr"] = "sum(rate(node_network_receive_bytes_total[5m]))"
		}},
		{"kept panel dropped", "30_edit_remove_panel", "kept as it was: disk-used", dropPanels("disk-used")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cs, ref := loadCase(t, c.caseID)
			failsOn(t, cs, edit(t, ref, c.fn), Stores{}, c.failing)
		})
	}
}

// A decline case passes a declined answer with a reason and fails a
// dashboard; a build case fails a decline.
func TestDecline(t *testing.T) {
	c, ref := loadCase(t, "17_decline_throttling")
	if r := Grade(context.Background(), c, ref, Stores{}); !r.Pass {
		t.Fatalf("the reference decline fails: %+v", r.Failed())
	}
	failsOn(t, c, []byte(`{"declined": "  "}`), Stores{}, "declined with a reason")
	_, dashboard := loadCase(t, "06_cpu_vs_request")
	failsOn(t, c, dashboard, Stores{}, "declined, not answered")

	build, _ := loadCase(t, "01_namespace_resources")
	failsOn(t, build, ref, Stores{}, "answered, not declined")

	// with a Prometheus, the data the case says is missing must be missing
	store := fakeStore{series: map[string]int{`count by (__name__) ({__name__=~"container_cpu_cfs_.*"})`: 2}}
	r := failsOn(t, c, ref, Stores{Prometheus: store}, "the store has none of: container_cpu_cfs_")
	if ch := check(r, "declined with a reason"); ch == nil || !ch.Pass {
		t.Errorf("the decline itself should still pass: %+v", r.Checks)
	}
	store.series = map[string]int{}
	if r := Grade(context.Background(), c, ref, Stores{Prometheus: store}); !r.Pass || !r.Live {
		t.Errorf("a store without the data should pass live: %+v", r.Failed())
	}
}

// Answers that pass in another way than the reference.
func TestOtherWaysPass(t *testing.T) {
	cases := []struct {
		name, caseID string
		fn           func(map[string]any)
	}{
		{"only the pod side", "13_memory_heavy", dropPanels("nodes")},
		{"only the node side", "13_memory_heavy", dropPanels("pods")},
		{"three of six", "11_cluster_health", dropPanels("restarts", "unavailable", "mem")},
		{"errors read with a regex", "22_logs_errors", replaceExpr(`| logfmt | level="ERROR"`, `|~ "(?i)level=error"`)},
		{"slow traces in a table", "25_slow_traces", setKind("slow", "table")},
		{"irate instead of rate", "01_namespace_resources", replaceExpr("rate(container_cpu", "irate(container_cpu")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cs, ref := loadCase(t, c.caseID)
			if r := Grade(context.Background(), cs, edit(t, ref, c.fn), Stores{}); !r.Pass {
				t.Errorf("failed: %+v", r.Failed())
			}
		})
	}
}

func TestQuantileWithoutLE(t *testing.T) {
	for in, want := range map[string]bool{
		`histogram_quantile(0.9, sum by (le) (rate(x_bucket[5m])))`:       false,
		`histogram_quantile(0.9, sum by (job) (rate(x_bucket[5m])))`:      true,
		`histogram_quantile(0.9, sum without (pod) (rate(x_bucket[5m])))`: false,
		`histogram_quantile(0.9, sum without (le) (rate(x_bucket[5m])))`:  true,
		`histogram_quantile(0.9, rate(x_bucket[5m]))`:                     false,
	} {
		f, err := analyse(in)
		if err != nil {
			t.Fatal(err)
		}
		if f.quantileNoLE != want {
			t.Errorf("%s: no le = %v, want %v", in, f.quantileNoLE, want)
		}
	}
}

func TestUnfiltered(t *testing.T) {
	for in, want := range map[string]string{
		`x > 0`: `x`,
		`0 < x`: `x`,
		`topk(10, sum by (p) (increase(x[1h])) > 0)`: `topk(10, sum by (p) (increase(x[1h])))`,
		`(a / b) >= 0.9`:              `(a / b)`,
		`sum(x > bool 0)`:             ``,
		`a > b`:                       ``,
		`x`:                           ``,
		`max_over_time((x > 1)[5m:])`: `max_over_time((x)[5m:])`,
	} {
		got, changed := unfiltered(in)
		if changed != (want != "") || changed && got != want {
			t.Errorf("%s → %q (%v), want %q", in, got, changed, want)
		}
	}
}

func TestCountersNeedRates(t *testing.T) {
	for in, bare := range map[string]bool{
		`x_total`:                         true,
		`sum(x_total)`:                    true,
		`rate(x_total[5m])`:               false,
		`sum(increase(x_total[1h]))`:      false,
		`count(x_total)`:                  false,
		`sum(rate(x_bucket[5m])) by (le)`: false,
		`x_bytes`:                         false,
		`max_over_time(x_total[5m])`:      true,
	} {
		f, err := analyse(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := len(f.bareCounters) > 0; got != bare {
			t.Errorf("%s: bare counter = %v, want %v", in, got, bare)
		}
	}
}

func TestSubstitute(t *testing.T) {
	vals := map[string]string{"namespace": "web", "__rate_interval": "5m"}
	for in, want := range map[string]string{
		`rate(x{namespace="$namespace"}[$__rate_interval])`: `rate(x{namespace="web"}[5m])`,
		`x{namespace=~"${namespace:regex}"}`:                `x{namespace=~"web"}`,
		`x{namespace="[[namespace]]"}`:                      `x{namespace="web"}`,
		`x{pod="$pod"}`:                                     `x{pod="$pod"}`,
	} {
		if got := substitute(in, vals); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	d := &model.Dashboard{Spec: model.Spec{Variables: []model.Variable{
		{Name: "all", Current: json.RawMessage(`{"text": "All", "value": "$__all"}`)},
		{Name: "allv", AllValue: "web.*", Current: json.RawMessage(`{"value": ["$__all"]}`)},
		{Name: "multi", Current: json.RawMessage(`{"value": ["a", "b"]}`)},
		{Name: "opt", Options: []model.VariableOption{{Text: "x", Value: "x"}}},
	}}}
	v := values(Case{Vars: map[string]string{"multi": "case-wins"}}, d)
	for name, want := range map[string]string{"all": ".*", "allv": "web.*", "multi": "case-wins", "opt": "x", "__range": "1h"} {
		if v[name] != want {
			t.Errorf("%s = %q, want %q", name, v[name], want)
		}
	}
}

// fakeStore answers by query text.
type fakeStore struct {
	series map[string]int
	errs   map[string]error
	labels map[string]int
	sums   map[string]float64
}

func (f fakeStore) Query(_ context.Context, expr string) (int, error) {
	if err, ok := f.errs[expr]; ok {
		return 0, err
	}
	return f.series[expr], nil
}

func (f fakeStore) LabelValues(_ context.Context, label, match string) (int, error) {
	return f.labels[label+"|"+match], nil
}

func (f fakeStore) Sum(_ context.Context, expr string) (float64, int, error) {
	if err, ok := f.errs[expr]; ok {
		return 0, 0, err
	}
	return f.sums[expr], f.series[expr], nil
}

// fakeText answers LogQL and TraceQL by query text.
type fakeText struct {
	n      map[string]int
	labels []string
}

func (f fakeText) Query(_ context.Context, expr string, _ bool) (int, error) { return f.n[expr], nil }
func (f fakeText) Labels(context.Context) ([]string, error)                  { return f.labels, nil }

func TestLiveChecks(t *testing.T) {
	c, ref := loadCase(t, "07_pod_phase")
	store := fakeStore{
		series: map[string]int{`sum by (phase) (kube_pod_status_phase)`: 5},
		errs:   map[string]error{},
	}
	r := Grade(context.Background(), c, ref, Stores{Prometheus: store})
	var empty *Check
	for i, ch := range r.Checks {
		if ch.Name == "returns data: pending/A" {
			empty = &r.Checks[i]
		}
	}
	if r.Pass || empty == nil || empty.Pass || !strings.Contains(empty.Detail, `nothing has kube_pod_status_phase{phase="Pending"}`) {
		t.Fatalf("the empty Pending panel should fail and name the value no series has: %+v", r.Failed())
	}

	store.errs["sum by (phase) (kube_pod_status_phase)"] = errors.New("bad_data")
	r = Grade(context.Background(), c, ref, Stores{Prometheus: store})
	found := false
	for _, f := range r.Failed() {
		found = found || (f.Name == "returns data: by-phase/A" && strings.Contains(f.Detail, "query error"))
	}
	if !found {
		t.Errorf("a query error should fail its panel: %+v", r.Failed())
	}

	c1, ref1 := loadCase(t, "01_namespace_resources")
	r = Grade(context.Background(), c1, ref1, Stores{Prometheus: fakeStore{series: map[string]int{}, labels: map[string]int{}}})
	found = false
	for _, f := range r.Failed() {
		found = found || (f.Name == "variable has values: namespace" && f.Detail == "no values")
	}
	if !found {
		t.Errorf("a variable without values should fail: %+v", r.Failed())
	}

	// a metric that has series only while a condition holds may be empty
	c12, ref12 := loadCase(t, "12_workload_problems")
	r = Grade(context.Background(), c12, ref12, Stores{Prometheus: fakeStore{}})
	if ch := check(r, "returns data: waiting/A"); ch == nil || !ch.Pass {
		t.Errorf("an empty waiting_reason query should pass: %+v", ch)
	}
	if ch := check(r, "returns data: pending/A"); ch == nil || ch.Pass {
		t.Errorf("other empty queries still fail: %+v", ch)
	}

	// a query empty only because nothing passes its comparison now
	restarts := `topk(10, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])))`
	r = Grade(context.Background(), c12, ref12, Stores{Prometheus: fakeStore{series: map[string]int{restarts: 7}}})
	if ch := check(r, "returns data: restarts/A"); ch == nil || !ch.Pass || !strings.Contains(ch.Detail, "7 series") {
		t.Errorf("an empty filter over real series should pass: %+v", ch)
	}
	r = Grade(context.Background(), c12, ref12, Stores{Prometheus: fakeStore{}})
	if ch := check(r, "returns data: restarts/A"); ch == nil || ch.Pass {
		t.Errorf("an empty filter over nothing should fail: %+v", ch)
	}
}

// same_as passes when any query meeting the expectation sums to the
// reference's number, and fails when none does.
func TestSameAs(t *testing.T) {
	c, ref := loadCase(t, "04_deployment_replicas")
	want := `sum by (namespace, deployment) (kube_deployment_status_replicas_available)`
	spec := `sum by (namespace, deployment) (kube_deployment_spec_replicas)`
	store := fakeStore{series: map[string]int{want: 3, spec: 3, `sum(kube_deployment_spec_replicas - kube_deployment_status_replicas_available)`: 1},
		sums: map[string]float64{want: 9, spec: 10, `sum(kube_deployment_spec_replicas - kube_deployment_status_replicas_available)`: 1}}
	r := Grade(context.Background(), c, ref, Stores{Prometheus: store})
	if !r.Pass {
		t.Fatalf("the reference fails: %+v", r.Failed())
	}
	// an answer whose "ready" panel reads the ready count of one namespace only
	answer := edit(t, ref, replaceExpr("(kube_deployment_status_replicas_available)", `(kube_deployment_status_replicas_available{namespace="web"})`))
	store.series[`sum by (namespace, deployment) (kube_deployment_status_replicas_available{namespace="web"})`] = 1
	store.sums[`sum by (namespace, deployment) (kube_deployment_status_replicas_available{namespace="web"})`] = 2
	r = failsOn(t, c, answer, Stores{Prometheus: store}, "same number as the reference: 준비된 레플리카")
	if ch := check(r, "same number as the reference: 준비된 레플리카"); !strings.Contains(ch.Detail, "reference 9") {
		t.Errorf("the detail should give both numbers: %s", ch.Detail)
	}
	if ch := check(r, "same number as the reference: 원하는 레플리카"); ch == nil || !ch.Pass {
		t.Errorf("the other number still matches: %+v", ch)
	}
}

// Loki and Tempo queries run on their stores; an empty Loki query names the
// labels Loki does not have.
func TestLiveLogsAndTraces(t *testing.T) {
	c, ref := loadCase(t, "21_logs_namespace")
	loki := fakeText{n: map[string]int{`{k8s_namespace_name="kube-system"}`: 40}, labels: []string{"k8s_namespace_name", "k8s_pod_name"}}
	r := Grade(context.Background(), c, ref, Stores{Loki: loki})
	if ch := check(r, "returns data: logs/A"); ch == nil || !ch.Pass {
		t.Errorf("the logs query should return data: %+v", ch)
	}
	if ch := check(r, "returns data: volume/A"); ch == nil || ch.Pass {
		t.Errorf("an empty metric query should fail: %+v", ch)
	}
	answer := edit(t, ref, replaceExpr("k8s_namespace_name", "namespace"))
	r = Grade(context.Background(), c, answer, Stores{Loki: loki})
	if ch := check(r, "returns data: logs/A"); ch == nil || ch.Pass || !strings.Contains(ch.Detail, "Loki has no label namespace") {
		t.Errorf("a label Loki does not have should be named: %+v", ch)
	}

	c, ref = loadCase(t, "25_slow_traces")
	tempo := fakeText{n: map[string]int{`{ resource.service.name = "kubeast-eval-shop" && duration > 1s }`: 12}}
	if r := Grade(context.Background(), c, ref, Stores{Tempo: tempo}); !r.Pass || !r.Live {
		t.Errorf("the slow traces should pass live: %+v", r.Failed())
	}
	if r := Grade(context.Background(), c, ref, Stores{Tempo: fakeText{}}); r.Pass {
		t.Error("no traces should fail live")
	}
}

func TestAnalyseText(t *testing.T) {
	for _, tc := range []struct {
		expr, store string
		selectors   int
		metric      bool
		labels      []string
	}{
		{`{app="a"} |= "x"`, "loki", 1, false, []string{"app"}},
		{`sum by (k) (count_over_time({app="a", ns=~"b"} | logfmt [5m]))`, "loki", 1, true, []string{"app", "ns"}},
		{`rate({app="a"}[1m]) / rate({app="b"}[1m])`, "loki", 2, true, []string{"app"}},
		{`{ resource.service.name = "s" && duration > 1s }`, "tempo", 1, false, []string{"resource.service.name", "duration"}},
		{`{ status = error } | rate() by (span.http.route)`, "tempo", 1, true, []string{"status"}},
		{`{ span.http.route =~ "/pay.*" } | quantile_over_time(duration, .9)`, "tempo", 1, true, []string{"span.http.route"}},
	} {
		f := analyseLog(tc.expr)
		if tc.store == "tempo" {
			f = analyseTrace(tc.expr)
		}
		if f.selectors != tc.selectors || f.metric != tc.metric {
			t.Errorf("%s: %d selectors, metric %v; want %d, %v", tc.expr, f.selectors, f.metric, tc.selectors, tc.metric)
		}
		for _, l := range tc.labels {
			if !f.labels[l] {
				t.Errorf("%s: no label %s in %v", tc.expr, l, f.labels)
			}
		}
	}
}

func TestLokiAndTempoClients(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	var mu sync.Mutex
	seen := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.URL.RawQuery
		mu.Unlock()
		switch r.URL.Path {
		case "/loki/api/v1/query_range":
			if r.URL.Query().Get("step") != "" {
				w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[{"values":[[1,"2"]]},{"values":[]},{"values":[[1,"1"]]}]}}`))
				return
			}
			w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[{"values":[["1","a"],["2","b"]]},{"values":[["3","c"]]}]}}`))
		case "/loki/api/v1/labels":
			w.Write([]byte(`{"status":"success","data":["k8s_namespace_name","service_name"]}`))
		case "/api/search":
			w.Write([]byte(`{"traces":[{"traceID":"a"},{"traceID":"b"}]}`))
		case "/api/metrics/query_range":
			w.Write([]byte(`{"series":[{"samples":[{"value":0},{"value":0.5}]},{"samples":[{"value":0}]}]}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`parse error at line 1`))
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	l := Loki{Base: srv.URL, Now: func() time.Time { return now }}
	if n, err := l.Query(ctx, `{a="b"}`, false); err != nil || n != 3 {
		t.Errorf("log lines = %d, %v; want 3", n, err)
	}
	if n, err := l.Query(ctx, `rate({a="b"}[1m])`, true); err != nil || n != 2 {
		t.Errorf("metric series = %d, %v; want 2 with values", n, err)
	}
	if v, _ := url.ParseQuery(seen["/loki/api/v1/query_range"]); v.Get("start") != strconv.FormatInt(now.Add(-time.Hour).UnixNano(), 10) ||
		v.Get("end") != strconv.FormatInt(now.UnixNano(), 10) {
		t.Errorf("the last hour in nanoseconds: %s", seen["/loki/api/v1/query_range"])
	}
	if ls, err := l.Labels(ctx); err != nil || len(ls) != 2 {
		t.Errorf("labels = %v, %v", ls, err)
	}
	tp := Tempo{Base: srv.URL, Now: func() time.Time { return now }}
	if n, err := tp.Query(ctx, `{ status = error }`, false); err != nil || n != 2 {
		t.Errorf("traces = %d, %v; want 2", n, err)
	}
	if n, err := tp.Query(ctx, `{ status = error } | rate()`, true); err != nil || n != 1 {
		t.Errorf("series above zero = %d, %v; want 1", n, err)
	}
	for _, path := range []string{"/api/search", "/api/metrics/query_range"} {
		if v, _ := url.ParseQuery(seen[path]); v.Get("start") != strconv.FormatInt(now.Add(-time.Hour).Unix(), 10) ||
			v.Get("end") != strconv.FormatInt(now.Unix(), 10) {
			t.Errorf("Tempo takes seconds: %s %s", path, seen[path])
		}
	}
	if _, err := (Loki{Base: srv.URL + "/nope"}).Query(ctx, "x", false); err == nil || !strings.Contains(err.Error(), "parse error") {
		t.Errorf("error = %v, want the store's message", err)
	}
}

// The seed sends what the seeded cases read: OTLP traces with the shop's
// service, slow /checkout and failing /pay spans in the last 90 seconds (Tempo
// searches a span only within two minutes of its arrival), and logfmt lines
// with ERROR levels in the last ten minutes.
func TestSeed(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	got := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got[r.URL.Path] = b
		if r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	ctx := context.Background()
	if err := SeedTraces(ctx, srv.URL, now); err != nil {
		t.Fatal(err)
	}
	if err := SeedLogs(ctx, srv.URL+"/", now); err != nil {
		t.Fatal(err)
	}

	var traces struct {
		ResourceSpans []struct {
			Resource struct {
				Attributes []struct {
					Key   string `json:"key"`
					Value struct {
						StringValue string `json:"stringValue"`
					} `json:"value"`
				} `json:"attributes"`
			} `json:"resource"`
			ScopeSpans []struct {
				Spans []struct {
					Name    string `json:"name"`
					TraceID string `json:"traceId"`
					SpanID  string `json:"spanId"`
					Start   string `json:"startTimeUnixNano"`
					End     string `json:"endTimeUnixNano"`
					Status  struct {
						Code int `json:"code"`
					} `json:"status"`
				} `json:"spans"`
			} `json:"scopeSpans"`
		} `json:"resourceSpans"`
	}
	if err := json.Unmarshal(got["/v1/traces"], &traces); err != nil {
		t.Fatal(err)
	}
	if a := traces.ResourceSpans[0].Resource.Attributes[0]; a.Key != "service.name" || a.Value.StringValue != SeedService {
		t.Errorf("service = %+v", a)
	}
	slow, failed, roots := 0, 0, 0
	type window struct {
		span       string
		start, end int64
	}
	rootOf := map[string]window{} // trace id → its server span
	for _, s := range traces.ResourceSpans[0].ScopeSpans[0].Spans {
		start, _ := strconv.ParseInt(s.Start, 10, 64)
		end, _ := strconv.ParseInt(s.End, 10, 64)
		if start < now.Add(-90*time.Second).UnixNano() || end > now.UnixNano() {
			t.Errorf("%s outside the last 90 seconds", s.Name)
		}
		if !strings.HasPrefix(s.Name, "GET ") {
			continue
		}
		if !strings.HasPrefix(s.TraceID, fmt.Sprintf("%016x", now.Unix())) || len(s.TraceID) != 32 {
			t.Errorf("trace id %s does not carry the run's time", s.TraceID)
		}
		roots++
		rootOf[s.TraceID] = window{s.SpanID, start, end}
		if time.Duration(end-start) > time.Second {
			slow++
		}
		if s.Status.Code == 2 {
			failed++
		}
	}
	if roots != 60 || slow == 0 || failed == 0 {
		t.Errorf("%d traces, %d over a second, %d failed", roots, slow, failed)
	}

	var logs struct {
		Streams []struct {
			Stream map[string]string   `json:"stream"`
			Values [][]json.RawMessage `json:"values"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(got["/loki/api/v1/push"], &logs); err != nil {
		t.Fatal(err)
	}
	st := logs.Streams[0]
	if st.Stream["service_name"] != SeedService || st.Stream["k8s_namespace_name"] != "kubeast-eval" {
		t.Errorf("stream = %v", st.Stream)
	}
	errorsN, plain, traced := 0, 0, 0
	seen := map[string]bool{}
	strOf := func(raw json.RawMessage) string {
		var v string
		_ = json.Unmarshal(raw, &v)
		return v
	}
	for _, v := range st.Values {
		line := strOf(v[1])
		if strings.Contains(line, "level=ERROR") && strings.Contains(line, "route=/pay") {
			errorsN++
		}
		if len(v) == 2 {
			plain++
			continue
		}
		// a line inside a trace: its trace_id and span_id are that trace's server span
		var meta map[string]string
		_ = json.Unmarshal(v[2], &meta)
		ts, _ := strconv.ParseInt(strOf(v[0]), 10, 64)
		w, ok := rootOf[meta["trace_id"]]
		if !ok || meta["span_id"] != w.span || ts < w.start || ts > w.end || seen[meta["trace_id"]] {
			t.Errorf("line %s %s does not sit in its trace's server span %+v", strOf(v[0]), meta, w)
		}
		seen[meta["trace_id"]] = true
		traced++
	}
	if plain != 120 || traced != 60 || errorsN != 14+7 {
		t.Errorf("%d plain lines, %d inside traces, %d /pay errors; want 120, 60, 21", plain, traced, errorsN)
	}

	if err := SeedLogs(ctx, srv.URL+"/nope", now); err != nil {
		t.Errorf("a 204 from any path is accepted: %v", err)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("entry too far behind"))
	}))
	defer bad.Close()
	if err := SeedLogs(ctx, bad.URL, now); err == nil || !strings.Contains(err.Error(), "entry too far behind") {
		t.Errorf("error = %v, want the store's message", err)
	}
}

func TestPrometheusClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/query" && r.URL.Query().Get("query") == "up":
			w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{},{}]}}`))
		case r.URL.Path == "/api/v1/query" && r.URL.Query().Get("query") == "1":
			w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[0,"1"]}}`))
		case r.URL.Path == "/api/v1/query":
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"parse error"}`))
		case r.URL.Path == "/api/v1/label/namespace/values" && r.URL.Query().Get("match[]") == "kube_pod_info":
			w.Write([]byte(`{"status":"success","data":["a","b","c"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`404`))
		}
	}))
	defer srv.Close()
	p := Prometheus{Base: srv.URL}
	ctx := context.Background()
	if n, err := p.Query(ctx, "up"); err != nil || n != 2 {
		t.Errorf("up = %d, %v; want 2 series", n, err)
	}
	if n, err := p.Query(ctx, "1"); err != nil || n != 1 {
		t.Errorf("scalar = %d, %v; want 1", n, err)
	}
	if _, err := p.Query(ctx, "up{"); err == nil || !strings.Contains(err.Error(), "parse error") {
		t.Errorf("error = %v, want the store's message", err)
	}
	if n, err := p.LabelValues(ctx, "namespace", "kube_pod_info"); err != nil || n != 3 {
		t.Errorf("label values = %d, %v; want 3", n, err)
	}
	if _, err := p.LabelValues(ctx, "nope", ""); err == nil {
		t.Error("a 404 that is not a Prometheus answer should be an error")
	}
}

func TestLoadCasesRefuses(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"unknown field":       {"case.json": `{"question": "q", "expect": [{"what": "w", "metrics": ["m"]}], "colour": 1}`, "reference.json": `{}`},
		"no reference":        {"case.json": `{"question": "q", "expect": [{"what": "w", "metrics": ["m"]}]}`},
		"edit without base":   {"case.json": `{"question": "q", "kind": "edit", "expect": [{"what": "w"}]}`, "reference.json": `{}`},
		"unknown kind":        {"case.json": `{"question": "q", "kind": "guess", "expect": [{"what": "w"}]}`, "reference.json": `{}`},
		"decline, no forbid":  {"case.json": `{"question": "q", "kind": "decline"}`, "reference.json": `{"declined": "x"}`},
		"forbid not a prefix": {"case.json": `{"question": "q", "kind": "decline", "forbid": ["gpu.*"]}`, "reference.json": `{"declined": "x"}`},
		"nothing expected":    {"case.json": `{"question": "q"}`, "reference.json": `{}`},
		"need above of":       {"case.json": `{"question": "q", "expect_any": {"need": 2, "of": [{"what": "w"}]}}`, "reference.json": `{}`},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			os.MkdirAll(filepath.Join(dir, "01_x"), 0o755)
			for f, body := range files {
				os.WriteFile(filepath.Join(dir, "01_x", f), []byte(body), 0o644)
			}
			if _, err := LoadCases(dir); err == nil {
				t.Error("loaded")
			}
		})
	}
}
