package anomaly

import (
	"strings"
	"testing"
	"time"
)

var sigWin = Window{Start: time.Date(2026, 11, 15, 0, 30, 0, 0, time.UTC), End: time.Date(2026, 11, 15, 1, 30, 0, 0, time.UTC)}

func at(h, m int) int64 { return time.Date(2026, 11, 15, h, m, 0, 0, time.UTC).Unix() }

func TestLogQueriesKeepToTheWorkloadAndAddNoScopeOfTheirOwn(t *testing.T) {
	l := LogLabels{Pod: "k8s_pod_name", Container: "k8s_container_name"}
	if got := LogSelector(l, nil); got != "{}" {
		t.Fatalf("selector %s", got)
	}
	wl := &Workload{Kind: "Deployment", Name: "api.v2"}
	if got := LogSelector(l, wl); got != `{k8s_pod_name=~"api\\.v2-[bcdfghjklmnpqrstvwxz2456789]{1,10}-[bcdfghjklmnpqrstvwxz2456789]{5}"}` {
		t.Fatalf("selector %s", got)
	}
	want := `sum by (k8s_container_name) (count_over_time({} |~ "(?i)(error|exception|fatal|panic)" [3600s]))`
	if got := ErrorCountQuery(l, nil, time.Hour); got != want {
		t.Fatalf("count query %s", got)
	}
	qs := TraceQueries(wl)
	if len(qs) != 3 || !strings.Contains(qs[1].Query, "status = error") || !strings.Contains(qs[2].Query, "quantile_over_time(duration, .9)") {
		t.Fatalf("%+v", qs)
	}
	for _, q := range qs {
		if !strings.Contains(q.Query, `kind = server && `) && !strings.Contains(q.Query, "kind = server ") {
			t.Errorf("not server spans: %s", q.Query)
		}
		if !strings.Contains(q.Query, `resource.k8s.pod.name =~ "^(?:api\\.v2-[bcdfghjklmnpqrstvwxz2456789]{1,10}-[bcdfghjklmnpqrstvwxz2456789]{5})$"`) || !strings.HasSuffix(q.Query, "by (resource.service.name)") {
			t.Errorf("query %s", q.Query)
		}
	}
}

func TestErrorShapesNewFirstAboveTheMinimum(t *testing.T) {
	r := FromPatterns([]PatternSample{
		// new in the window: anomalous, new
		{Pattern: `level=error msg="dial tcp <_>: connection refused"`, Level: "error", Samples: [][2]int64{{at(0, 40), 6}, {at(1, 0), 6}}},
		// below the minimum in the window: not listed
		{Pattern: `panic: <_>`, Level: "", Samples: [][2]int64{{at(1, 0), 4}}},
		// the same as before: normal
		{Pattern: `ERROR <_> timeout`, Level: "unknown", Samples: [][2]int64{{at(0, 0), 10}, {at(1, 0), 11}}},
		// info shape with an error word: not an error shape
		{Pattern: `retrying after error <_>`, Level: "info", Samples: [][2]int64{{at(0, 0), 1}, {at(1, 0), 50}}},
	}, sigWin)
	if r.NotRun != "" || len(r.Findings) != 2 {
		t.Fatalf("%+v", r)
	}
	if f := r.Findings[0]; f.Verdict != VerdictAnomalous || !f.New || *f.Now != 12 || *f.Before != 0 || !strings.Contains(f.Summary, "level error") {
		t.Fatalf("%+v", f)
	}
	if f := r.Findings[1]; f.Verdict != VerdictNormal || *f.Ratio != 1.1 {
		t.Fatalf("%+v", f)
	}

	long := strings.Repeat("x", 150)
	r = FromPatterns([]PatternSample{{Pattern: "error " + long, Samples: [][2]int64{{at(0, 0), 1}, {at(1, 0), 5}}}}, sigWin)
	if f := r.Findings[0]; len([]rune(f.Target)) != patternTarget+1 || len(f.Examples) != 1 || !strings.HasPrefix(f.Examples[0], "error xxx") {
		t.Fatalf("a long shape is cut in the target and kept whole in the example: %+v", f)
	}
}

func TestErrorShapesWithNothingBeforeAreNotCompared(t *testing.T) {
	if r := FromPatterns(nil, sigWin); r.NotRun != NoPatterns {
		t.Fatalf("%+v", r)
	}
	r := FromPatterns([]PatternSample{{Pattern: "error <_>", Level: "error", Samples: [][2]int64{{at(1, 0), 50}}}}, sigWin)
	if r.NotRun != NoPatternsBefore || len(r.Findings) != 0 {
		t.Fatalf("shapes the store no longer holds for the window before would all read as new: %+v", r)
	}
}

func TestErrorCountsPerContainer(t *testing.T) {
	r := FromLogCounts(map[string]float64{"app": 9, "sidecar": 5, "quiet": 2, "": 7}, map[string]float64{"app": 2, "sidecar": 4}, EarlierUnknown)
	got := map[string]Finding{}
	for _, f := range r.Findings {
		got[f.Target] = f
	}
	if len(r.Findings) != 3 || got["container app"].Verdict != VerdictAnomalous || *got["container app"].Ratio != 4.5 ||
		got["container sidecar"].Verdict != VerdictNormal || !got["containers without a name label"].New {
		t.Fatalf("%+v", r.Findings)
	}
	if r := FromLogCounts(map[string]float64{}, map[string]float64{}, EarlierUnknown); r.NotRun != "" || len(r.Findings) != 0 {
		t.Fatalf("no error line in either window is normal once the store said it holds lines: %+v", r)
	}
}

func TestTraceStepCutsBothWindowsOnTheirBounds(t *testing.T) {
	cases := []struct {
		w    Window
		want time.Duration
		ok   bool
	}{
		{sigWin, 15 * time.Minute, true},
		{Window{Start: sigWin.Start.Add(7 * time.Minute), End: sigWin.End.Add(7 * time.Minute)}, time.Minute, true},
		{Window{Start: sigWin.End.Add(-5 * time.Minute), End: sigWin.End}, 75 * time.Second, true},
		{Window{Start: sigWin.Start.Add(13 * time.Second), End: sigWin.End}, 0, false},
	}
	for _, c := range cases {
		got, ok := TraceStep(c.w)
		if got != c.want || ok != c.ok {
			t.Errorf("%v: %v %v, want %v %v", c.w, got, ok, c.want, c.ok)
		}
		if ok && (c.w.Start.Unix()%int64(got/time.Second) != 0 || c.w.Length()/got < 4) {
			t.Errorf("%v: step %v does not cut the window on its bounds", c.w, got)
		}
	}
}

// points labels a step by its start (start=true) or its end, as a store may; the steps on a window's bound are read by neither window.
func points(step time.Duration, start bool, before, now float64, bound float64) [][2]float64 {
	var out [][2]float64
	s := int64(step / time.Second)
	for t := sigWin.Before().Start.Unix(); t <= sigWin.End.Unix(); t += s {
		label := t
		if !start {
			label = t + s
		}
		v := now
		if t < sigWin.Start.Unix() {
			v = before
		}
		if label == sigWin.Start.Unix() || label == sigWin.End.Unix() || label == sigWin.Before().Start.Unix() {
			v = bound
		}
		out = append(out, [2]float64{float64(label), v})
	}
	return out
}

func TestTraceChecksReadTheSameWhicheverEndAStepIsLabelledBy(t *testing.T) {
	for _, start := range []bool{true, false} {
		requests := []TraceSeries{
			{Service: "cart", Points: points(15*time.Minute, start, 100, 100, 1e6)},
			{Service: "gone", Points: points(15*time.Minute, start, 30, 0, 0)},
			{Service: "tiny", Points: points(15*time.Minute, start, 1, 2, 0)},
		}
		errs := []TraceSeries{{Service: "cart", Points: points(15*time.Minute, start, 0, 10, 1e6)}}
		p90 := []TraceSeries{{Service: "cart", Points: points(15*time.Minute, start, 0.05, 0.3, 9)}}

		req := FromTraceRequests(requests, sigWin)
		byTarget := map[string]Finding{}
		for _, f := range req.Findings {
			byTarget[f.Target] = f
		}
		if len(req.Findings) != 2 || byTarget["service cart"].Verdict != VerdictNormal || *byTarget["service cart"].Now != 300 ||
			byTarget["service gone"].Verdict != VerdictAnomalous || *byTarget["service gone"].Ratio != 0 {
			t.Fatalf("start=%v requests %+v", start, req.Findings)
		}
		e := FromTraceErrors(requests, errs, sigWin)
		if len(e.Findings) != 1 || e.Findings[0].Verdict != VerdictAnomalous || *e.Findings[0].Now != 0.1 || !strings.Contains(e.Findings[0].Summary, "10.0% of server spans failed (30 of 300)") {
			t.Fatalf("start=%v errors %+v", start, e.Findings)
		}
		l := FromTraceLatency(p90, sigWin)
		if len(l.Findings) != 1 || l.Findings[0].Verdict != VerdictAnomalous || *l.Findings[0].Ratio != 6 || !strings.Contains(l.Findings[0].Summary, "300 ms") {
			t.Fatalf("start=%v latency %+v", start, l.Findings)
		}
	}
}

func TestTraceChecksWithoutSpansDoNotRun(t *testing.T) {
	for _, r := range []CheckResult{FromTraceRequests(nil, sigWin), FromTraceErrors(nil, nil, sigWin), FromTraceLatency(nil, sigWin)} {
		if r.NotRun != NoSpans {
			t.Errorf("%+v", r)
		}
	}
	// a p90 that doubled under 100 ms is not a finding to rank; one with nothing before has no baseline
	l := FromTraceLatency([]TraceSeries{
		{Service: "fast", Points: points(15*time.Minute, true, 0.01, 0.05, 0)},
		{Service: "new", Points: points(15*time.Minute, true, 0, 0.5, 0)},
	}, sigWin)
	for _, f := range l.Findings {
		if f.Verdict != VerdictNormal {
			t.Errorf("%+v", f)
		}
	}
}

func TestNewChecksRankAfterTheOldOnATie(t *testing.T) {
	if checkOrder(CheckCPUThrottling) >= checkOrder(CheckErrorLogShapes) || checkOrder(CheckTraceRequests) >= checkOrder(CheckNodeConditions) {
		t.Fatal(Checks)
	}
	if len(Checks) != 11 || len(LogChecks)+len(TraceChecks) != 5 {
		t.Fatal(Checks)
	}
}
