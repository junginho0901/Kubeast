package anomaly

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"
)

// asSent is what the answer's JSON says of a finding: new only when it is true, before only when the window before has
// a value.
func asSent(t *testing.T, f Finding) map[string]interface{} {
	t.Helper()
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func saysNoEarlierData(t *testing.T, f Finding) {
	t.Helper()
	m := asSent(t, f)
	if f.Verdict != VerdictAnomalous || m["new"] != nil || m["before"] != nil || m["ratio"] != nil || !strings.Contains(f.Summary, NoEarlier) {
		t.Errorf("want a finding with no earlier data: %v", m)
	}
}

func saysNew(t *testing.T, f Finding) {
	t.Helper()
	m := asSent(t, f)
	if f.Verdict != VerdictAnomalous || m["new"] != true || m["before"] != float64(0) || strings.Contains(f.Summary, NoEarlier) {
		t.Errorf("want a new finding: %v", m)
	}
}

func byTarget(r CheckResult) map[string]Finding {
	out := map[string]Finding{}
	for _, f := range r.Findings {
		out[f.Target] = f
	}
	return out
}

// Each metric check: a series with none in the window before has no earlier data; one whose value was 0 there is new.
func TestAMetricFindingIsNewOnlyWithASeriesInTheWindowBefore(t *testing.T) {
	ctr := func(pod string, v float64) Sample {
		return Sample{Labels: map[string]string{"pod": pod, "container": "app"}, Value: v}
	}
	for _, c := range []struct {
		check  string
		now    float64
		target string
	}{
		{CheckRestarts, 4, "Pod/%"},
		{CheckMemoryNearLimit, 0.97, "Pod/% container app"},
		{CheckCPUThrottling, 0.6, "Pod/%"},
	} {
		got := byTarget(FromMetric(c.check, []Sample{ctr("was", c.now), ctr("made", c.now)}, []Sample{ctr("was", 0)}))
		saysNew(t, got[strings.Replace(c.target, "%", "was", 1)])
		saysNoEarlierData(t, got[strings.Replace(c.target, "%", "made", 1)])
	}
}

// A metric check with series in the window before only, or with no number in the window, did not run.
func TestAMetricCheckWithNothingInTheWindowIsNotRun(t *testing.T) {
	pod := []Sample{{Labels: map[string]string{"pod": "web"}, Value: 2}}
	if r := FromMetric(CheckRestarts, nil, pod); r.NotRun != NoSeriesNow || len(r.Findings) != 0 {
		t.Errorf("%+v", r)
	}
	none := []Sample{{Labels: map[string]string{"pod": "web"}, Value: -1}}
	if r := FromMetric(CheckRestarts, none, nil); r.NotRun != NoSeries {
		t.Errorf("%+v", r)
	}
	if r := FromMetric(CheckRestarts, pod, nil); r.NotRun != "" {
		t.Errorf("%+v", r)
	}
}

// The issue and the node check read the objects as they are now: a critical one is not new, and is still ranked first.
func TestAStateNowIsNotNewAndStillFirst(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	rows := []IssueRow{
		{Kind: "Pod", Name: "web-1-a", Severity: "critical", Reason: "CrashLoopBackOff", Message: strings.Repeat("back-off ", 40)},
		{Kind: "Deployment", Name: "web", Severity: "warning", Reason: "Unavailable"},
		{Kind: "Node", Name: "n1", Severity: "critical", Reason: "NotReady"},
	}
	pods := []map[string]interface{}{pod("web-1-a")}
	grown := CheckResult{Check: CheckRestarts, Findings: []Finding{{Check: CheckRestarts, Target: "Pod/web-1-a", Verdict: VerdictAnomalous, Now: f(90), Ratio: f(30)}}}
	res := Assemble("shop", nil, w, []CheckResult{FromIssues(rows, folded(pods, nil, w)), FromNodeConditions(rows, folded(pods, nil, w), ""), grown}, 0)
	var order []string
	for _, f := range res.Findings {
		order = append(order, f.Check+":"+f.Target)
		if f.Check == CheckRestarts {
			continue
		}
		if m := asSent(t, f); m["new"] != nil {
			t.Errorf("a state now called new: %v", m)
		}
		// what ranks beside the new says that it is not known to be; a warning, which ranks last, says nothing of it
		critical := strings.HasPrefix(f.Summary, "critical now ("+NoEarlier+"): ")
		if !critical && (!strings.HasPrefix(f.Summary, "warning now: ") || strings.Contains(f.Summary, NoEarlier)) {
			t.Errorf("summary %q", f.Summary)
		}
	}
	if got := strings.Join(order, ","); got != "issues:Pod/web-1-a,node_conditions_not_cpu:Node/n1,restarts:Pod/web-1-a,issues:Deployment/web" {
		t.Fatalf("order %s", got)
	}
}

// What has no earlier data ranks after what is new and before what grew.
func TestRankPutsNoEarlierDataBetweenNewAndGrown(t *testing.T) {
	two, zero := 2.0, 0.0
	var isNew, unknown, grown Finding
	isNew, unknown, grown = Finding{Check: CheckRestarts, Target: "new"}, Finding{Check: CheckRestarts, Target: "unknown"}, Finding{Check: CheckRestarts, Target: "grown"}
	compare(&isNew, &zero, 1)
	compare(&unknown, nil, 50)
	compare(&grown, &two, 60)
	list := []Finding{grown, unknown, isNew}
	Rank(list)
	if list[0].Target != "new" || list[1].Target != "unknown" || list[2].Target != "grown" {
		t.Fatalf("%+v", list)
	}
}

// A container keeps its last termination and the one before while it is terminated: whether it ended in the window
// before is known only when those are all of them and its pod was there then.
func TestACrashReasonIsNewOnlyWhenTheWindowBeforeIsKnown(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	old, made := now.Add(-48*time.Hour).Format(time.RFC3339), now.Add(-20*time.Minute).Format(time.RFC3339)
	row := func(created string, restarts int32, state, last map[string]interface{}) []map[string]interface{} {
		return []map[string]interface{}{{"name": "web-1-a", "created_at": created, "owner_references": owners("ReplicaSet", "web-1"),
			"containers": []map[string]interface{}{{"name": "app", "restart_count": restarts, "state": state, "last_state": last}}}}
	}
	running := map[string]interface{}{"running": map[string]interface{}{"started_at": old}}
	waiting := map[string]interface{}{"waiting": map[string]interface{}{"reason": "CrashLoopBackOff"}}
	ago := func(d time.Duration) map[string]interface{} {
		return map[string]interface{}{"terminated": ended("Error", now.Add(-d))}
	}
	cases := []struct {
		name  string
		pods  []map[string]interface{}
		isNew bool
	}{
		{"its first end, running again", row(old, 1, running, ago(5*time.Minute)), true},
		{"its first end, waiting to start again", row(old, 0, waiting, ago(5*time.Minute)), true},
		{"its two ends, both in the window", row(old, 1, ago(time.Minute), ago(5*time.Minute)), true},
		{"a container that kept restarting", row(old, 8, waiting, ago(5*time.Minute)), false},
		{"two ends of which it shows one", row(old, 2, running, ago(5*time.Minute)), false},
		{"two ends of which it shows one, waiting to start again", row(old, 1, waiting, ago(5*time.Minute)), false},
		{"a pod made in the window", row(made, 1, running, ago(5*time.Minute)), false},
		{"a pod made in the window that kept restarting", row(made, 6, waiting, ago(time.Minute)), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := FromCrashReasons(folded(c.pods, nil, w))
			if len(r.Findings) != 1 || r.NotRun != "" {
				t.Fatalf("%+v", r)
			}
			if c.isNew {
				saysNew(t, r.Findings[0])
			} else {
				saysNoEarlierData(t, r.Findings[0])
			}
		})
	}
	// one that ended for it before gives the count before, whatever others hide
	counted := append(row(old, 9, waiting, ago(5*time.Minute)), row(old, 1, running, ago(70*time.Minute))...)
	if f := FromCrashReasons(folded(counted, nil, w)).Findings[0]; f.New || f.Before == nil || *f.Before != 1 || strings.Contains(f.Summary, NoEarlier) {
		t.Errorf("%+v", f)
	}

	// a first Error beside another container of the pods read: new only when that one hides nothing of the window before
	other := func(reason string, d time.Duration) map[string]interface{} {
		return map[string]interface{}{"terminated": ended(reason, now.Add(-d))}
	}
	first := func() []map[string]interface{} { return row(old, 1, running, ago(5*time.Minute)) }
	starting := map[string]interface{}{"waiting": map[string]interface{}{"reason": "ContainerCreating"}}
	initRow := func(restarts int32, state map[string]interface{}) []map[string]interface{} {
		return []map[string]interface{}{{"name": "web-1-b", "created_at": old, "owner_references": owners("ReplicaSet", "web-1"),
			"init_containers": []map[string]interface{}{{"name": "proxy", "restart_count": restarts, "state": state}}}}
	}
	for _, c := range []struct {
		name  string
		pods  []map[string]interface{}
		isNew bool
	}{
		{"it hides nothing", row(old, 0, running, nil), true},
		{"its ends are all kept", row(old, 1, running, other("OOMKilled", 2*time.Minute)), true},
		{"its record was overwritten by another reason", row(old, 2, running, other("OOMKilled", 2*time.Minute)), false},
		{"its record was overwritten by a completion", row(old, 3, running, other("Completed", 2*time.Minute)), false},
		{"its record of the window before was overwritten there", row(old, 2, running, other("OOMKilled", 70*time.Minute)), false},
		{"its last end was before the window before", row(old, 9, running, other("Error", 3*time.Hour)), true},
		{"the earlier of two ends it keeps was before the window before", row(old, 9, other("OOMKilled", time.Minute), other("Error", 3*time.Hour)), true},
		{"it restarted and keeps no end", row(old, 1, running, nil), false},
		{"it was never started", row(old, 0, starting, nil), true},
		{"its pod was made in the window", row(made, 9, waiting, other("OOMKilled", time.Minute)), true},
		{"a sidecar that restarted, whose row keeps no last end", initRow(1, running), false},
		{"an init container that is done", initRow(0, other("Completed", 48*time.Hour)), true},
		{"an init container that keeps failing and shows no end", initRow(0, waiting), false},
	} {
		t.Run("beside one: "+c.name, func(t *testing.T) {
			f, ok := byTarget(FromCrashReasons(folded(append(first(), c.pods...), nil, w)))["Error"]
			if !ok {
				t.Fatal("no Error")
			}
			if c.isNew {
				saysNew(t, f)
			} else {
				saysNoEarlierData(t, f)
			}
		})
	}
	// the other container belongs to another workload: it was not read
	elsewhere := row(old, 9, waiting, other("OOMKilled", time.Minute))
	elsewhere[0]["owner_references"] = owners("ReplicaSet", "api-5d4f8c7b9")
	saysNew(t, byTarget(FromCrashReasons(folded(append(first(), elsewhere...), &Workload{Kind: "ReplicaSet", Name: "web-1"}, w)))["Error"])
}

func TestErrorLinesAreNewOnlyWithLinesInTheWindowBefore(t *testing.T) {
	counts, none := map[string]float64{"app": 9}, map[string]float64{}
	saysNew(t, FromLogCounts(counts, none, EarlierSome).Findings[0])
	saysNoEarlierData(t, FromLogCounts(counts, none, EarlierNone).Findings[0])
	f := FromLogCounts(counts, none, EarlierUnknown).Findings[0]
	if m := asSent(t, f); f.Verdict != VerdictAnomalous || m["new"] != nil || m["before"] != nil || !strings.Contains(f.Summary, "0 in the window before (whether the log store holds earlier lines was not checked)") {
		t.Errorf("not known: %v", m)
	}
	// an error line of another container before is data of that window too
	other := FromLogCounts(map[string]float64{"app": 9, "side": 8}, map[string]float64{"side": 7}, EarlierUnknown)
	saysNew(t, byTarget(other)["container app"])

	for _, c := range []struct {
		now, before map[string]float64
		want        bool
	}{
		{map[string]float64{"app": 9}, nil, true},
		{map[string]float64{"app": 9}, map[string]float64{"app": 0}, true},
		{map[string]float64{"app": 4}, nil, false}, // under MinLogLines: nothing to list
		{map[string]float64{"app": 9}, map[string]float64{"side": 1}, false},
		{nil, nil, false},
	} {
		if got := LogCountsNeedEarlier(c.now, c.before); got != c.want {
			t.Errorf("%v %v: %v", c.now, c.before, got)
		}
	}
	shape := []PatternSample{{Pattern: "GET /", Level: "info", Samples: [][2]int64{{at(0, 0), 40}}}}
	if LinesIn(shape, sigWin) || !LinesIn(shape, sigWin.Before()) || LinesIn(nil, sigWin) {
		t.Error("a shape of the window before is a line of it, whatever its level, and of no other")
	}
	if HasLines(nil) || HasLines(map[string]float64{"app": 0}) || !HasLines(map[string]float64{"app": 0, "side": 1}) {
		t.Error("a container with a line")
	}
}

// Shapes in the window before only: there is nothing to read in the window, which is not a normal value.
func TestErrorShapesWithNothingInTheWindowAreNotRun(t *testing.T) {
	r := FromPatterns([]PatternSample{{Pattern: "error <_>", Level: "error", Samples: [][2]int64{{at(0, 0), 50}}}}, sigWin)
	if r.NotRun != NoPatternsNow || len(r.Findings) != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestTraceChecksSayWhatTheyCouldNotCompare(t *testing.T) {
	step := 15 * time.Minute
	series := func(svc string, before, now float64) TraceSeries {
		return TraceSeries{Service: svc, Points: points(step, true, before, now, 0)}
	}
	// no span of any service in the window before
	fresh := []TraceSeries{series("cart", 0, 100)}
	if r := FromTraceRequests(fresh, sigWin); r.NotRun != NoSpansBefore || len(r.Findings) != 0 {
		t.Errorf("requests: %+v", r)
	}
	if r := FromTraceLatency([]TraceSeries{series("cart", 0, 3)}, sigWin); r.NotRun != NoSpansBefore || len(r.Findings) != 0 {
		t.Errorf("latency: %+v", r)
	}
	// a failed share stands on its own: it is a finding, with no earlier data
	e := FromTraceErrors(fresh, []TraceSeries{series("cart", 0, 10)}, sigWin)
	if e.NotRun != "" || len(e.Findings) != 1 {
		t.Fatalf("errors: %+v", e)
	}
	saysNoEarlierData(t, e.Findings[0])

	// spans in the window before only
	gone := []TraceSeries{series("cart", 100, 0)}
	if r := FromTraceErrors(gone, nil, sigWin); r.NotRun != NoSpansNow {
		t.Errorf("errors: %+v", r)
	}
	if r := FromTraceLatency([]TraceSeries{series("cart", 0.2, 0)}, sigWin); r.NotRun != NoSpansNow {
		t.Errorf("latency: %+v", r)
	}
	if r := FromTraceRequests(gone, sigWin); r.NotRun != "" || len(r.Findings) != 1 || r.Findings[0].Verdict != VerdictAnomalous {
		t.Errorf("requests that stopped are a finding: %+v", r)
	}

	// a service that appeared beside one with spans before is new, and its p90 has nothing to be compared with
	some := []TraceSeries{series("cart", 100, 100), series("pay", 0, 100)}
	got := byTarget(FromTraceRequests(some, sigWin))
	saysNew(t, got["service pay"])
	l := FromTraceLatency([]TraceSeries{series("cart", 0.2, 0.2), series("pay", 0, 3)}, sigWin)
	if l.NotRun != "" || l.Partial != "not compared, no server spans in the window before: service pay" {
		t.Errorf("latency: %+v", l)
	}
	many := []TraceSeries{series("cart", 0.2, 0.2)}
	for _, svc := range []string{"a", "b", "c", "d", "e"} {
		many = append(many, series(svc, 0, 1))
	}
	if l := FromTraceLatency(many, sigWin); l.Partial != "not compared, no server spans in the window before: service a, service b, service c and 2 more" {
		t.Errorf("latency: %+v", l.Partial)
	}
	// every service with spans now appeared, and one that had them before is gone
	if l := FromTraceLatency([]TraceSeries{series("cart", 0.2, 0), series("pay", 0, 3)}, sigWin); l.NotRun != "not compared, no server spans in the window before: service pay" {
		t.Errorf("latency: %+v", l)
	}
}

// A normal node check is listed by its name alone, so the name says it is not about CPU; with no node to look at it did
// not run, and neither did the terminations with no pod to read.
func TestTheNodeCheckSaysWhatItCovers(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	pods := []map[string]interface{}{pod("web-1-a")}
	res := Assemble("shop", nil, w, []CheckResult{FromNodeConditions(nil, folded(pods, nil, w), "")}, 0)
	if strings.Join(res.Normal, ",") != "node_conditions_not_cpu" || len(res.NotRun) != 0 {
		t.Fatalf("%+v", res)
	}
	for _, c := range Checks {
		if strings.Contains(c, "pressure") {
			t.Errorf("a check named %s", c)
		}
	}
	unplaced := []map[string]interface{}{{"name": "web-1-a"}}
	for name, r := range map[string]CheckResult{
		"no pods":        FromNodeConditions(nil, folded(nil, nil, w), ""),
		"no pod placed":  FromNodeConditions(nil, folded(unplaced, nil, w), ""),
		"no pod of it":   FromNodeConditions(nil, folded(pods, &Workload{Kind: "Deployment", Name: "api"}, w), ""),
		"node list fail": FromNodeConditions(nil, folded(pods, nil, w), "forbidden"),
	} {
		res := Assemble("shop", nil, w, []CheckResult{r}, 0)
		if len(res.Normal) != 0 || len(res.NotRun) != 1 || res.NotRun[0].Check != CheckNodeConditions || res.NotRun[0].Reason == "" {
			t.Errorf("%s: %+v", name, res)
		}
	}
	if r := FromCrashReasons(folded(nil, nil, w)); r.NotRun != NoPods {
		t.Errorf("%+v", r)
	}
	if r := FromCrashReasons(folded(pods, &Workload{Kind: "Deployment", Name: "api"}, w)); r.NotRun != NoPods {
		t.Errorf("%+v", r)
	}
	if r := FromCrashReasons(folded(pods, nil, w)); r.NotRun != "" {
		t.Errorf("%+v", r)
	}
}

// The answer's fields are what they were: a finding that is not new leaves new out, and what it says instead is in its
// summary, so whoever reads the answer reads the same fields.
func TestTheAnswersFieldsAreAsBefore(t *testing.T) {
	keys := func(v interface{}) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return strings.Join(out, ",")
	}
	whole := Finding{Check: "c", Target: "t", Verdict: VerdictAnomalous, Summary: "s", Before: f(1), Now: f(2), Ratio: f(2), New: true, Examples: []string{"e"}, critical: true, noEarlier: true}
	if got := keys(whole); got != "before,check,examples,new,now,ratio,summary,target,verdict" {
		t.Errorf("a finding: %s", got)
	}
	w := Window{Start: now.Add(-time.Hour), End: now}
	res := AssembleWith("shop", &Workload{Kind: "Deployment", Name: "web"}, w, []CheckResult{
		{Check: CheckRestarts, Findings: []Finding{whole}, Partial: "p"}, {Check: CheckCPUThrottling, NotRun: "n"}}, 1, &CallOrder{})
	// whole's one value has no earlier data, so the answer says it has no baseline (nobaseline_test.go)
	if got := keys(res); got != "call_order,compared_with,findings,findings_total,namespace,no_baseline,normal,not_run,partial,store_queries,window,workload" {
		t.Errorf("the answer: %s", got)
	}
	if got := keys(res.NoBaseline); got != "compared,no_earlier_data,note" {
		t.Errorf("no_baseline: %s", got)
	}
	if got := keys(res.NotRun[0]) + " " + keys(res.Partial[0]); got != "check,reason check,reason" {
		t.Errorf("not run and partial: %s", got)
	}
}
