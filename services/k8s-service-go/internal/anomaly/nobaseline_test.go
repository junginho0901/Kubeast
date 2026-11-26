package anomaly

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"slices"
	"sort"
	"testing"
	"time"
)

func podSample(pod string, v float64) Sample {
	return Sample{Labels: map[string]string{"pod": pod}, Value: v}
}

func ctrSample(pod, ctr string, v float64) Sample {
	return Sample{Labels: map[string]string{"pod": pod, "container": ctr}, Value: v}
}

// A namespace made after the window before: no value it compared has data there. The answer says so first, with how many
// it compared, and with nothing that grew against the window before the findings keep Rank's order.
func TestANamespaceNewerThanTheWindowBeforeSaysSoFirst(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	throttled := FromMetric(CheckCPUThrottling, []Sample{podSample("busy-1", 0.404), podSample("job-1", 0.333), podSample("job-2", 0.333),
		podSample("web-1", 0.02), podSample("db-1", 0.01)}, nil)
	restarts := FromMetric(CheckRestarts, []Sample{podSample("busy-1", 0), podSample("job-1", 0), podSample("web-1", 0), podSample("db-1", 0)}, nil)
	memory := FromMetric(CheckMemoryNearLimit, []Sample{ctrSample("web-1", "app", 0.3), ctrSample("db-1", "db", 0.4)}, nil)
	warnings := FromIssues([]IssueRow{{Kind: "Pod", Name: "job-1", Severity: "warning", Reason: "PolicyViolation"},
		{Kind: "Pod", Name: "job-2", Severity: "warning", Reason: "PolicyViolation"}}, folded(nil, nil, w))
	res := Assemble("shop", nil, w, []CheckResult{warnings, restarts, memory, throttled}, 3)
	if res.NoBaseline == nil || *res.NoBaseline != (NoBaseline{Compared: 11, NoEarlierData: 11, Note: NoBaselineNote}) {
		t.Fatalf("no_baseline %+v", res.NoBaseline)
	}
	wantOrder(t, res, "cpu_throttling Pod/busy-1", "cpu_throttling Pod/job-1", "cpu_throttling Pod/job-2", "issues Pod/job-1", "issues Pod/job-2")
	ranked := slices.Clone(res.Findings)
	Rank(ranked)
	if !slices.EqualFunc(ranked, res.Findings, func(a, b Finding) bool { return a.Check == b.Check && a.Target == b.Target }) {
		t.Fatalf("with nothing that grew the order is not Rank's: %v", targets(res))
	}
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	want := `{"compared":11,"no_earlier_data":11,"note":"` + NoBaselineNote + `"}`
	if string(m["no_baseline"]) != want {
		t.Fatalf("no_baseline in the answer: %s", m["no_baseline"])
	}
}

// In such an answer a value that grew against the window before comes right after what is new or critical now, before the
// larger values with no earlier data; Rank, the order of an answer with a baseline, puts those first.
func TestWithoutABaselineWhatGrewComesBeforeWhatHasNoEarlierData(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	throttled := FromMetric(CheckCPUThrottling, []Sample{podSample("new-1", 0.6), podSample("new-2", 0.5), podSample("new-3", 0.1), podSample("old-1", 0.4)},
		[]Sample{podSample("old-1", 0.2)})
	issues := FromIssues([]IssueRow{{Kind: "Pod", Name: "new-1", Severity: "critical", Reason: "CrashLoopBackOff"},
		{Kind: "Deployment", Name: "web", Severity: "warning", Reason: "Unavailable"}}, folded(nil, nil, w))
	res := Assemble("shop", nil, w, []CheckResult{issues, throttled}, 1)
	if res.NoBaseline == nil || res.NoBaseline.Compared != 4 || res.NoBaseline.NoEarlierData != 3 {
		t.Fatalf("no_baseline %+v", res.NoBaseline)
	}
	wantOrder(t, res, "issues Pod/new-1", "cpu_throttling Pod/old-1", "cpu_throttling Pod/new-1", "cpu_throttling Pod/new-2", "issues Deployment/web")
	ranked := slices.Clone(res.Findings)
	Rank(ranked)
	wantOrder(t, Result{Findings: ranked}, "issues Pod/new-1", "cpu_throttling Pod/new-1", "cpu_throttling Pod/new-2", "cpu_throttling Pod/old-1", "issues Deployment/web")
}

// Most is more than half: half of the values compared without earlier data is not most, and an answer that compared no
// value (states now only) has a baseline to say nothing of.
func TestHalfWithoutEarlierDataIsNotMost(t *testing.T) {
	for _, c := range []struct {
		compared, none int
		want           bool
	}{{0, 0, false}, {1, 0, false}, {1, 1, true}, {2, 1, false}, {4, 2, false}, {5, 3, true}, {11, 11, true}} {
		if got := (earlierData{compared: c.compared, none: c.none}).note() != nil; got != c.want {
			t.Errorf("%d of %d: %v", c.none, c.compared, got)
		}
	}
	w := Window{Start: now.Add(-time.Hour), End: now}
	states := FromIssues([]IssueRow{{Kind: "Pod", Name: "web-1", Severity: "critical", Reason: "CrashLoopBackOff"}}, folded(nil, nil, w))
	if res := Assemble("shop", nil, w, []CheckResult{states}, 0); res.NoBaseline != nil {
		t.Fatalf("states only: %+v", res.NoBaseline)
	}
}

// A termination markBefore finds of a pod failing since before the window was there before: it is not counted as a value
// with no earlier data. The same termination of a pod that began failing in the window is.
func TestATerminationThereBeforeIsNotAValueWithNoEarlierData(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	ended := func() CheckResult {
		f := Finding{Check: CheckCrashReasons, Target: "Error", Verdict: VerdictAnomalous, Summary: "1 container terminations with reason Error in the window, " + NoEarlier,
			pods: []string{"p1"}}
		compare(&f, nil, 1)
		return CheckResult{Check: CheckCrashReasons, Findings: []Finding{f}}
	}
	row := IssueRow{Kind: "Pod", Name: "p1", Severity: "critical", Reason: "CrashLoopBackOff", Before: true}
	if res := Assemble("shop", nil, w, []CheckResult{FromIssues([]IssueRow{row}, folded(nil, nil, w)), ended()}, 0); res.NoBaseline != nil {
		t.Fatalf("there before: %+v", res.NoBaseline)
	}
	row.Before = false
	res := Assemble("shop", nil, w, []CheckResult{FromIssues([]IssueRow{row}, folded(nil, nil, w)), ended()}, 0)
	if res.NoBaseline == nil || res.NoBaseline.Compared != 1 || res.NoBaseline.NoEarlierData != 1 {
		t.Fatalf("begun in the window: %+v", res.NoBaseline)
	}
}

// rankBefore and assembleBefore are Rank and AssembleWith as they were before an answer could say it has no baseline
// (a4a0caa6b).
func rankBefore(findings []Finding) {
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i], findings[j]
		if ta, tb := a.tier(), b.tier(); ta != tb {
			return ta < tb
		}
		if ra, rb := value(a.Ratio), value(b.Ratio); ra != rb {
			return ra > rb
		}
		if na, nb := value(a.Now), value(b.Now); na != nb {
			return na > nb
		}
		if oa, ob := checkOrder(a.Check), checkOrder(b.Check); oa != ob {
			return oa < ob
		}
		return a.Target < b.Target
	})
}

func assembleBefore(namespace string, wl *Workload, w Window, results []CheckResult, storeQueries int, order *CallOrder) Result {
	out := Result{Namespace: namespace, Workload: wl, Window: windowJSON(w), ComparedWith: windowJSON(w.Before()),
		Findings: []Finding{}, Normal: []string{}, NotRun: []NotRun{}, StoreQueries: storeQueries}
	byCheck := map[string]CheckResult{}
	for _, r := range results {
		byCheck[r.Check] = r
	}
	var found []Finding
	for _, check := range Checks {
		r, ok := byCheck[check]
		if !ok {
			continue
		}
		if r.NotRun != "" {
			out.NotRun = append(out.NotRun, NotRun{Check: check, Reason: r.NotRun})
			continue
		}
		anomalous := 0
		for _, f := range r.Findings {
			if f.Verdict == VerdictAnomalous {
				found = append(found, f)
				anomalous++
			}
		}
		if anomalous == 0 {
			out.Normal = append(out.Normal, check)
		}
		if r.Partial != "" {
			out.Partial = append(out.Partial, Partial{Check: check, Reason: r.Partial})
		}
	}
	markBefore(found)
	rankBefore(found)
	if order != nil {
		note := order.Note
		if len(order.Suspects) > 0 {
			note.Applied, note.Moved = true, order.apply(found)
			note.Suspects = append([]string{}, order.Suspects[:min(len(order.Suspects), MaxCallOrderSuspects)]...)
		}
		out.CallOrder = &note
	}
	out.FindingsTotal = len(found)
	if len(found) > MaxFindings {
		found = found[:MaxFindings]
	}
	out.Findings = append(out.Findings, found...)
	return out
}

// randomResults are the checks' results of a made-up namespace: some not asked or not run, states now on pods (some there
// before the window, so markBefore moves terminations), terminations of those pods, and values new, grown, steady or with no
// earlier data — in one namespace of four most of them with no earlier data, as in one made in the window.
func randomResults(r *rand.Rand) []CheckResult {
	fresh := r.Intn(4) == 0
	var out []CheckResult
	for _, check := range Checks {
		switch r.Intn(6) {
		case 0:
			continue
		case 1:
			out = append(out, CheckResult{Check: check, NotRun: "not read"})
			continue
		}
		cr := CheckResult{Check: check}
		for i, n := 0, r.Intn(7); i < n; i++ {
			pod := fmt.Sprintf("p%d", r.Intn(6))
			f := Finding{Check: check, Target: "Pod/" + pod, Verdict: VerdictNormal, Summary: "s"}
			if r.Intn(2) == 0 {
				f.Verdict = VerdictAnomalous
			}
			switch check {
			case CheckIssues, CheckNodeConditions:
				f.critical, f.AlreadyThere = r.Intn(2) == 0, r.Intn(3) == 0
			default:
				if check == CheckCrashReasons {
					f.Target, f.pods = []string{"Error", "OOMKilled"}[r.Intn(2)], []string{pod}
				}
				v := float64(r.Intn(5))
				switch k := r.Intn(4); {
				case k == 0 || (fresh && r.Intn(5) > 0):
					compare(&f, nil, v)
				case k == 1:
					zero := 0.0
					compare(&f, &zero, v)
				default:
					b := float64(1 + r.Intn(4))
					compare(&f, &b, v)
				}
			}
			cr.Findings = append(cr.Findings, f)
		}
		if r.Intn(5) == 0 {
			cr.Partial = "part"
		}
		out = append(out, cr)
	}
	return out
}

// valuesCompared counts, over the checks that ran, the findings with a value and those of them with no earlier data, the
// anomalous ones as markBefore leaves them.
func valuesCompared(results []CheckResult) (compared, none int) {
	var anomalous []Finding
	count := func(f Finding) {
		if f.Now != nil {
			compared++
			if f.noEarlier {
				none++
			}
		}
	}
	for _, r := range results {
		if r.NotRun != "" {
			continue
		}
		for _, f := range r.Findings {
			if f.Verdict == VerdictAnomalous {
				anomalous = append(anomalous, f)
			} else {
				count(f)
			}
		}
	}
	markBefore(anomalous)
	for _, f := range anomalous {
		count(f)
	}
	return compared, none
}

func randomOrder(r *rand.Rand) *CallOrder {
	switch r.Intn(3) {
	case 0:
		return nil
	case 1:
		return &CallOrder{Note: CallOrderNote{Reason: "no failing workload"}}
	}
	return &CallOrder{Suspects: []string{"w2", "w0", "w1"}[:1+r.Intn(3)], Workload: func(target string) string {
		if pod, ok := targetPod(target); ok {
			return fmt.Sprintf("w%d", int(pod[len(pod)-1]-'0')%3)
		}
		return ""
	}}
}

// An answer whose window before has data for at least half of what it compared is, to the byte, the answer it was before
// no_baseline (fields, findings, their order and cut); one without has the same findings and checks with no_baseline, the
// values with no earlier data after those that grew.
func TestAnAnswerWithABaselineIsTheBytesItWas(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	r := rand.New(rand.NewSource(1126))
	with, without := 0, 0
	for i := 0; i < 4000; i++ {
		results, order := randomResults(r), randomOrder(r)
		got := AssembleWith("shop", nil, w, results, i%5, order)
		was := assembleBefore("shop", nil, w, results, i%5, order)
		compared, none := valuesCompared(results)
		if most := 2*none > compared; most != (got.NoBaseline != nil) ||
			most && (got.NoBaseline.Compared != compared || got.NoBaseline.NoEarlierData != none) {
			t.Fatalf("case %d: %d of %d values with no earlier data, no_baseline %+v", i, none, compared, got.NoBaseline)
		}
		if got.NoBaseline == nil {
			with++
			a, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(was)
			if err != nil {
				t.Fatal(err)
			}
			if string(a) != string(b) {
				t.Fatalf("case %d differs\n%s\n%s", i, a, b)
			}
			continue
		}
		without++
		if got.NoBaseline.Note != NoBaselineNote {
			t.Fatalf("case %d: %+v", i, got.NoBaseline)
		}
		if got.FindingsTotal != was.FindingsTotal || !slices.Equal(got.Normal, was.Normal) || !slices.Equal(got.NotRun, was.NotRun) ||
			!slices.Equal(got.Partial, was.Partial) || len(got.Findings) != len(was.Findings) {
			t.Fatalf("case %d: the checks differ\n%+v\n%+v", i, got, was)
		}
		if order == nil {
			for k := 1; k < len(got.Findings); k++ {
				if got.Findings[k-1].tierWithoutBaseline() > got.Findings[k].tierWithoutBaseline() {
					t.Fatalf("case %d: %s before %s", i, got.Findings[k-1].Target, got.Findings[k].Target)
				}
			}
		}
	}
	if with < 1000 || without < 200 {
		t.Fatalf("%d answers with a baseline and %d without: too few of one", with, without)
	}
	t.Logf("%d answers with a baseline the bytes they were, %d without", with, without)
}
