package anomaly

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
)

var now = time.Date(2026, 11, 15, 1, 30, 42, 0, time.UTC)

func TestParseWindow_DefaultsToTheHourBeforeNowCutToTheMinute(t *testing.T) {
	w, err := ParseWindow("", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 15, 1, 30, 0, 0, time.UTC); !w.End.Equal(want) || !w.Start.Equal(want.Add(-time.Hour)) {
		t.Fatalf("window %v – %v", w.Start, w.End)
	}
	if b := w.Before(); !b.End.Equal(w.Start) || b.Length() != time.Hour {
		t.Fatalf("before %v – %v", b.Start, b.End)
	}
}

func TestParseWindow_AnEndAfterNowIsNow(t *testing.T) {
	w, err := ParseWindow("2026-11-15T01:00:00Z", "2026-11-15T09:00:00Z", now)
	if err != nil {
		t.Fatal(err)
	}
	if !w.End.Equal(now.Truncate(time.Minute)) {
		t.Fatalf("end %v", w.End)
	}
}

func TestParseWindow_RefusesWhatItCannotCompare(t *testing.T) {
	for _, c := range []struct{ start, end string }{
		{"yesterday", ""},
		{"", "soon"},
		{"2026-11-15T01:29:00Z", ""}, // one minute: shorter than MinLength
		{"2026-11-13T01:00:00Z", "2026-11-15T01:00:00Z"}, // two days: longer than MaxLength
		{"2026-11-15T01:20:00Z", "2026-11-15T01:10:00Z"}, // backwards
		{"2026-11-08T00:00:00Z", "2026-11-08T12:00:00Z"}, // the window before reaches past MaxBack
	} {
		if _, err := ParseWindow(c.start, c.end, now); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%q – %q: %v, want an invalid request", c.start, c.end, err)
		}
	}
}

func TestParseNamespace(t *testing.T) {
	if err := ParseNamespace("shop-1"); err != nil {
		t.Fatal(err)
	}
	for _, ns := range []string{"", "Shop", `shop"}`, "shop.prod", strings.Repeat("a", 64)} {
		if err := ParseNamespace(ns); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%q: %v, want an invalid request", ns, err)
		}
	}
}

func TestParseWorkload(t *testing.T) {
	if wl, err := ParseWorkload("", ""); wl != nil || err != nil {
		t.Fatalf("none: %v %v", wl, err)
	}
	for _, c := range [][2]string{{"Deployment", ""}, {"", "web"}, {"Pod", "web"}, {"Deployment", "Web"}, {"Deployment", `web"}`}} {
		if _, err := ParseWorkload(c[0], c[1]); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%v: %v, want an invalid request", c, err)
		}
	}
}

func owners(kind, name string) []map[string]interface{} {
	return []map[string]interface{}{{"kind": kind, "name": name}}
}

func TestWorkloadOwnsItsPodsThroughReplicaSetsAndJobs(t *testing.T) {
	dep := &Workload{Kind: "Deployment", Name: "web"}
	if !dep.OwnsPod(owners("ReplicaSet", "web-6d4b9c")) || dep.OwnsPod(owners("ReplicaSet", "webhook-6d4b9c")) || dep.OwnsPod(owners("StatefulSet", "web")) {
		t.Fatal("Deployment owner match")
	}
	cron := &Workload{Kind: "CronJob", Name: "report"}
	if !cron.OwnsPod(owners("Job", "report-29123")) || cron.OwnsPod(owners("Job", "reporter-1")) {
		t.Fatal("CronJob owner match")
	}
	sts := &Workload{Kind: "StatefulSet", Name: "db"}
	if !sts.OwnsPod(owners("StatefulSet", "db")) || sts.OwnsPod(nil) {
		t.Fatal("StatefulSet owner match")
	}
	var none *Workload
	if !none.OwnsPod(nil) {
		t.Fatal("no workload keeps every pod")
	}
}

// Every query parses, names the namespace in every selector and, with a workload, its pods.
func TestQueriesParseAndStayInTheNamespace(t *testing.T) {
	for _, wl := range []*Workload{nil, {Kind: "Deployment", Name: "web.v2"}} {
		for _, q := range Queries("shop", wl, time.Hour) {
			expr, err := parser.NewParser(parser.Options{}).ParseExpr(q.Expr)
			if err != nil {
				t.Fatalf("%s: %v\n%s", q.Check, err, q.Expr)
			}
			selectors := 0
			parser.Inspect(expr, func(node parser.Node, _ []parser.Node) error {
				vs, ok := node.(*parser.VectorSelector)
				if !ok {
					return nil
				}
				selectors++
				var ns, pod bool
				for _, m := range vs.LabelMatchers {
					if m.Name == "namespace" && m.Value == "shop" {
						ns = true
					}
					if m.Name == "pod" && m.Value == `web\.v2-.*` {
						pod = true
					}
				}
				if !ns || (wl != nil && !pod) {
					t.Errorf("%s: %s does not keep to the namespace and workload", q.Check, vs)
				}
				return nil
			})
			if selectors == 0 {
				t.Errorf("%s: no selector", q.Check)
			}
			if !strings.Contains(q.Expr, "[3600s]") {
				t.Errorf("%s: not over the window: %s", q.Check, q.Expr)
			}
		}
	}
}

func f(v float64) *float64 { return &v }

func TestFromMetric_ComparesEachPodWithTheWindowBefore(t *testing.T) {
	pod := func(name string, v float64) Sample { return Sample{Labels: map[string]string{"pod": name}, Value: v} }
	r := FromMetric(CheckRestarts, []Sample{pod("new", 3), pod("doubled", 4), pod("steady", 2), pod("quiet", 0)}, []Sample{pod("doubled", 2), pod("steady", 2), pod("quiet", 0)})
	got := map[string]Finding{}
	for _, f := range r.Findings {
		got[f.Target] = f
	}
	if f := got["Pod/new"]; f.Verdict != VerdictAnomalous || !f.New || f.Before != nil {
		t.Errorf("new: %+v", f)
	}
	if f := got["Pod/doubled"]; f.Verdict != VerdictAnomalous || f.Ratio == nil || *f.Ratio != 2 {
		t.Errorf("doubled: %+v", f)
	}
	if f := got["Pod/steady"]; f.Verdict != VerdictNormal {
		t.Errorf("steady: %+v", f)
	}
	if f := got["Pod/quiet"]; f.Verdict != VerdictNormal || f.New {
		t.Errorf("quiet: %+v", f)
	}
}

func TestFromMetric_AShareIsAnomalousWhenItCrossesItsThreshold(t *testing.T) {
	ctr := func(pod string, v float64) Sample {
		return Sample{Labels: map[string]string{"pod": pod, "container": "app"}, Value: v}
	}
	r := FromMetric(CheckMemoryNearLimit, []Sample{ctr("crossed", 0.95), ctr("always", 0.93), ctr("low", 0.5)}, []Sample{ctr("crossed", 0.6), ctr("always", 0.92), ctr("low", 0.2)})
	verdicts := map[string]string{}
	for _, f := range r.Findings {
		verdicts[f.Target] = f.Verdict
	}
	want := map[string]string{"Pod/crossed container app": VerdictAnomalous, "Pod/always container app": VerdictNormal, "Pod/low container app": VerdictNormal}
	for target, v := range want {
		if verdicts[target] != v {
			t.Errorf("%s: %q, want %q", target, verdicts[target], v)
		}
	}
}

// No series in either window is a check that could not run, not a normal one.
func TestFromMetric_NoSeriesIsNotRun(t *testing.T) {
	if r := FromMetric(CheckCPUThrottling, nil, nil); r.NotRun == "" {
		t.Fatalf("%+v", r)
	}
}

func pod(name string, terminations ...map[string]interface{}) map[string]interface{} {
	containers := make([]interface{}, 0, len(terminations))
	for i, t := range terminations {
		containers = append(containers, map[string]interface{}{"name": "c" + string(rune('0'+i)), "last_state": map[string]interface{}{"terminated": t}})
	}
	return map[string]interface{}{"name": name, "node_name": "n1", "containers": containers, "owner_references": owners("ReplicaSet", "web-1")}
}

func ended(reason string, at time.Time) map[string]interface{} {
	return map[string]interface{}{"reason": reason, "finished_at": at.Format(time.RFC3339), "exit_code": int32(137)}
}

func TestFromCrashReasons_CountsByReasonInBothWindows(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	pods := []map[string]interface{}{
		pod("web-1-a", ended("OOMKilled", now.Add(-10*time.Minute)), ended("Completed", now.Add(-5*time.Minute))),
		pod("web-1-b", ended("OOMKilled", now.Add(-20*time.Minute))),
		pod("web-1-c", ended("Error", now.Add(-70*time.Minute))),
		pod("web-1-d", ended("Error", now.Add(-30*time.Minute))),
	}
	r := FromCrashReasons(pods, nil, w)
	got := map[string]Finding{}
	for _, f := range r.Findings {
		got[f.Target] = f
	}
	if f := got["OOMKilled"]; f.Verdict != VerdictAnomalous || !f.New || *f.Now != 2 || len(f.Examples) != 2 || !strings.HasPrefix(f.Examples[0], "web-1-a/") {
		t.Errorf("OOMKilled: %+v", f)
	}
	if f := got["Error"]; f.Verdict != VerdictNormal || *f.Now != 1 || *f.Before != 1 {
		t.Errorf("Error: %+v", f)
	}
	if _, ok := got["Completed"]; ok {
		t.Error("Completed is not a crash")
	}
}

func TestFromIssues_LeavesNodesAndInfoOut(t *testing.T) {
	rows := []IssueRow{
		{Kind: "Pod", Name: "web-1-a", Severity: "critical", Reason: "CrashLoopBackOff"},
		{Kind: "Deployment", Name: "web", Severity: "warning", Reason: "Unavailable"},
		{Kind: "Pod", Name: "web-1-b", Severity: "info", Reason: "Restarted"},
		{Kind: "Node", Name: "n1", Severity: "warning", Reason: "MemoryPressure"},
	}
	r := FromIssues(rows, nil, nil)
	if len(r.Findings) != 2 || r.Findings[0].Target != "Pod/web-1-a" || !r.Findings[0].New || r.Findings[1].New {
		t.Fatalf("%+v", r.Findings)
	}
	nodes := FromNodePressure(rows, []map[string]interface{}{pod("web-1-a")}, nil, "")
	if len(nodes.Findings) != 1 || nodes.Findings[0].Target != "Node/n1" {
		t.Fatalf("%+v", nodes)
	}
	if refused := FromNodePressure(rows, nil, nil, "forbidden"); refused.NotRun == "" {
		t.Fatalf("a nodes list that failed is not run: %+v", refused)
	}
}

func TestFromIssues_AWorkloadKeepsItsOwnRows(t *testing.T) {
	rows := []IssueRow{
		{Kind: "Pod", Name: "web-1-a", Severity: "critical"},
		{Kind: "Pod", Name: "db-0", Severity: "critical"},
		{Kind: "Deployment", Name: "web", Severity: "warning"},
		{Kind: "StatefulSet", Name: "db", Severity: "warning"},
	}
	pods := []map[string]interface{}{pod("web-1-a"), {"name": "db-0", "owner_references": owners("StatefulSet", "db")}}
	r := FromIssues(rows, pods, &Workload{Kind: "Deployment", Name: "web"})
	if len(r.Findings) != 2 || r.Findings[0].Target != "Pod/web-1-a" || r.Findings[1].Target != "Deployment/web" {
		t.Fatalf("%+v", r.Findings)
	}
}

func TestAssemble_RanksNewThenRatioThenValueAndCapsAtTen(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	var many []Finding
	for i := 0; i < 12; i++ {
		many = append(many, Finding{Check: CheckRestarts, Target: "Pod/p" + string(rune('a'+i)), Verdict: VerdictAnomalous, Now: f(float64(i + 1)), Ratio: f(2)})
	}
	results := []CheckResult{
		{Check: CheckRestarts, Findings: many},
		{Check: CheckCrashReasons, Findings: []Finding{{Check: CheckCrashReasons, Target: "OOMKilled", Verdict: VerdictAnomalous, New: true, Now: f(1)}}},
		{Check: CheckCPUThrottling, Findings: []Finding{{Check: CheckCPUThrottling, Target: "Pod/x", Verdict: VerdictAnomalous, Now: f(0.5), Ratio: f(5)}}},
		{Check: CheckMemoryNearLimit, Findings: []Finding{{Check: CheckMemoryNearLimit, Target: "Pod/y", Verdict: VerdictNormal}}},
		{Check: CheckIssues},
		{Check: CheckNodePressure, NotRun: "the nodes could not be listed: forbidden"},
	}
	res := Assemble("shop", nil, w, results, 4)
	if len(res.Findings) != MaxFindings || res.FindingsTotal != 14 {
		t.Fatalf("%d findings of %d", len(res.Findings), res.FindingsTotal)
	}
	if res.Findings[0].Target != "OOMKilled" || res.Findings[1].Target != "Pod/x" || res.Findings[2].Target != "Pod/pl" {
		t.Fatalf("order: %s, %s, %s", res.Findings[0].Target, res.Findings[1].Target, res.Findings[2].Target)
	}
	if strings.Join(res.Normal, ",") != "issues,memory_near_limit" {
		t.Fatalf("normal: %v", res.Normal)
	}
	if len(res.NotRun) != 1 || res.NotRun[0].Check != CheckNodePressure {
		t.Fatalf("not run: %+v", res.NotRun)
	}
	if res.ComparedWith.End != res.Window.Start || res.StoreQueries != 4 {
		t.Fatalf("%+v", res)
	}
}

func TestCallOrderMovesTheSuspectsWithinTheirPlaces(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	w := Window{Start: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC), End: time.Date(2026, 11, 15, 1, 0, 0, 0, time.UTC)}
	results := []CheckResult{
		{Check: CheckRestarts, Findings: []Finding{
			{Check: CheckRestarts, Target: "Pod/web-1", Verdict: VerdictAnomalous, Now: f(8), Ratio: f(8)},
			{Check: CheckRestarts, Target: "Pod/api-1", Verdict: VerdictAnomalous, Now: f(3), Ratio: f(3)},
		}},
		{Check: CheckCrashReasons, Findings: []Finding{{Check: CheckCrashReasons, Target: "OOMKilled", Verdict: VerdictAnomalous, Now: f(2), Ratio: f(4)}}},
		{Check: CheckTraceErrors, Findings: []Finding{{Check: CheckTraceErrors, Target: "service web-svc", Verdict: VerdictAnomalous, Now: f(0.3), Ratio: f(6)}}},
	}
	workloads := map[string]string{"Pod/web-1": "D/web", "service web-svc": "D/web", "Pod/api-1": "D/api"}
	order := &CallOrder{Suspects: []string{"D/api", "D/web"}, Workload: func(t string) string { return workloads[t] }}
	before := Assemble("shop", nil, w, results, 0)
	got := AssembleWith("shop", nil, w, results, 0, order)
	targets := func(r Result) string {
		var out []string
		for _, f := range r.Findings {
			out = append(out, f.Target)
		}
		return strings.Join(out, ",")
	}
	// by the counts: web 8×, web-svc 6×, OOMKilled 4×, api 3×; api takes the first place a suspect held, OOMKilled keeps its own
	if targets(before) != "Pod/web-1,service web-svc,OOMKilled,Pod/api-1" {
		t.Fatalf("2-a order %s", targets(before))
	}
	if targets(got) != "Pod/api-1,Pod/web-1,OOMKilled,service web-svc" {
		t.Fatalf("call order %s", targets(got))
	}
	if got.CallOrder == nil || !got.CallOrder.Applied || got.CallOrder.Moved != 3 || strings.Join(got.CallOrder.Suspects, ",") != "D/api,D/web" {
		t.Fatalf("%+v", got.CallOrder)
	}
	if before.CallOrder != nil {
		t.Fatal("call_order without an order")
	}

	// no suspects: the order stays and the note says why; nil order: the answer of Assemble, byte for byte
	none := AssembleWith("shop", nil, w, results, 0, &CallOrder{Workload: order.Workload, Note: CallOrderNote{Reason: "no failing workload"}})
	if targets(none) != targets(before) || none.CallOrder.Applied || none.CallOrder.Reason != "no failing workload" {
		t.Fatalf("%s %+v", targets(none), none.CallOrder)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(AssembleWith("shop", nil, w, results, 0, nil))
	if string(a) != string(b) || strings.Contains(string(a), "call_order") {
		t.Fatalf("%s\n%s", a, b)
	}
}
