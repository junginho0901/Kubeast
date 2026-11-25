package anomaly

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func targets(res Result) []string {
	out := make([]string, 0, len(res.Findings))
	for _, f := range res.Findings {
		out = append(out, f.Check+" "+f.Target)
	}
	return out
}

func wantOrder(t *testing.T, res Result, want ...string) {
	t.Helper()
	if got := strings.Join(targets(res), " | "); got != strings.Join(want, " | ") {
		t.Fatalf("order\n%s\nwant\n%s", got, strings.Join(want, " | "))
	}
}

// What was there before the window comes after what is new and what grew, and says so in place of "no earlier data".
func TestAStateThereBeforeTheWindowComesAfterWhatIsNew(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	old := IssueRow{Kind: "Pod", Name: "notifier-1", Severity: "critical", Reason: "CrashLoopBackOff", Since: "2026-11-14T20:00:00Z"}
	fresh := IssueRow{Kind: "Pod", Name: "web-1", Severity: "critical", Reason: "CrashLoopBackOff"}
	others := []CheckResult{
		{Check: CheckErrorLogCounts, Findings: []Finding{{Check: CheckErrorLogCounts, Target: "container storefront", Verdict: VerdictAnomalous, noEarlier: true, Now: f(40)}}},
		{Check: CheckMemoryNearLimit, Findings: []Finding{{Check: CheckMemoryNearLimit, Target: "Pod/cart-1 container main", Verdict: VerdictAnomalous, Ratio: f(2), Now: f(0.95)}}},
	}
	run := func(rows ...IssueRow) Result {
		return Assemble("shop", nil, w, append([]CheckResult{FromIssues(rows, nil, nil)}, others...), 0)
	}
	// not asked for, or asked for and not before the window: it stays with what is critical now
	for _, row := range []IssueRow{{Kind: "Pod", Name: "notifier-1", Severity: "critical", Reason: "CrashLoopBackOff"}, old} {
		wantOrder(t, run(row, fresh), "issues Pod/notifier-1", "issues Pod/web-1", "error_log_counts container storefront", "memory_near_limit Pod/cart-1 container main")
	}
	old.Before = true
	res := run(old, fresh)
	wantOrder(t, res, "issues Pod/web-1", "error_log_counts container storefront", "memory_near_limit Pod/cart-1 container main", "issues Pod/notifier-1")
	last := res.Findings[3]
	if !last.AlreadyThere || last.Worse || last.Since != old.Since || last.Summary != "critical now (already there before the window): CrashLoopBackOff" {
		t.Fatalf("%+v", last)
	}
	// a warning says it too, and ranks last as it did
	old.Severity = "warning"
	if res := run(old); res.Findings[len(res.Findings)-1].Summary != "warning now (already there before the window): CrashLoopBackOff" {
		t.Fatalf("%+v", res.Findings)
	}
}

// One that another check found new or grown in the window is worse and keeps its place.
func TestAStateThereBeforeThatGotWorseKeepsItsPlace(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	old := IssueRow{Kind: "Pod", Name: "notifier-1", Severity: "critical", Reason: "CrashLoopBackOff", Since: "2026-11-14T20:00:00Z", Before: true}
	for name, other := range map[string]Finding{
		"restarts doubled":            {Check: CheckRestarts, Target: "Pod/notifier-1", Verdict: VerdictAnomalous, Ratio: f(3), Now: f(9)},
		"memory newly near its limit": {Check: CheckMemoryNearLimit, Target: "Pod/notifier-1 container main", Verdict: VerdictAnomalous, New: true, Now: f(0.99)},
		"a new reason to end":         {Check: CheckCrashReasons, Target: "OOMKilled", Verdict: VerdictAnomalous, New: true, Now: f(1), pods: []string{"notifier-1"}},
	} {
		res := Assemble("shop", nil, w, []CheckResult{FromIssues([]IssueRow{old}, nil, nil), {Check: other.Check, Findings: []Finding{other}}}, 0)
		var got Finding
		for _, fd := range res.Findings {
			if fd.Check == CheckIssues {
				got = fd
			}
		}
		if !got.AlreadyThere || !got.Worse || got.tier() != 0 {
			t.Errorf("%s: %+v", name, got)
		}
	}
	// the same of another pod, and a value that did not grow, do not make it worse
	for name, other := range map[string]Finding{
		"another pod": {Check: CheckRestarts, Target: "Pod/notifier-10", Verdict: VerdictAnomalous, Ratio: f(3), Now: f(9)},
		"no earlier":  {Check: CheckRestarts, Target: "Pod/notifier-1", Verdict: VerdictAnomalous, noEarlier: true, Now: f(9)},
	} {
		res := Assemble("shop", nil, w, []CheckResult{FromIssues([]IssueRow{old}, nil, nil), {Check: other.Check, Findings: []Finding{other}}}, 0)
		if last := res.Findings[len(res.Findings)-1]; last.Check != CheckIssues || last.Worse {
			t.Errorf("%s: %+v", name, res.Findings)
		}
	}
}

// The terminations of such pods alone were there before too; with another pod's among them nothing is said.
func TestTheTerminationsOfAPodThereBeforeAreNotNewNews(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	crashed := func(name string) map[string]interface{} {
		return map[string]interface{}{"name": name, "owner_references": owners("ReplicaSet", "rs"), "created_at": now.Add(-5 * time.Hour).Format(time.RFC3339),
			"containers": []map[string]interface{}{{"name": "main", "restart_count": int32(9), "state": map[string]interface{}{"waiting": map[string]interface{}{"reason": "CrashLoopBackOff"}},
				"last_state": map[string]interface{}{"terminated": map[string]interface{}{"reason": "Error", "exit_code": int32(1), "finished_at": now.Add(-4 * time.Minute).Format(time.RFC3339)}}}}}
	}
	old := IssueRow{Kind: "Pod", Name: "notifier-1", Severity: "critical", Reason: "CrashLoopBackOff", Since: "2026-11-14T20:00:00Z", Before: true}
	run := func(pods ...map[string]interface{}) Finding {
		res := Assemble("shop", nil, w, []CheckResult{FromIssues([]IssueRow{old}, pods, nil), FromCrashReasons(pods, nil, w)}, 0)
		for _, fd := range res.Findings {
			if fd.Check == CheckCrashReasons {
				return fd
			}
		}
		t.Fatalf("no termination found: %+v", res)
		return Finding{}
	}
	if fd := run(crashed("notifier-1")); !fd.AlreadyThere || fd.tier() != 2 || !strings.Contains(fd.Summary, "in the window, already there before the window (") {
		t.Fatalf("%+v", fd)
	}
	if fd := run(crashed("notifier-1"), crashed("web-1")); fd.AlreadyThere || fd.tier() != 1 || !strings.Contains(fd.Summary, NoEarlier) {
		t.Fatalf("%+v", fd)
	}
}

// Without the rows' Since nothing of it is in the answer.
func TestWithoutSinceTheAnswerHasNoneOfItsFields(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	rows := []IssueRow{{Kind: "Pod", Name: "web-1", Severity: "critical", Reason: "CrashLoopBackOff"}, {Kind: "Deployment", Name: "web", Severity: "warning", Reason: "Unavailable"}}
	res := Assemble("shop", nil, w, []CheckResult{FromIssues(rows, nil, nil),
		{Check: CheckRestarts, Findings: []Finding{{Check: CheckRestarts, Target: "Pod/web-1", Verdict: VerdictAnomalous, New: true, Now: f(3)}}}}, 1)
	out, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"since", "already_there", "worse"} {
		if strings.Contains(string(out), `"`+field+`"`) {
			t.Errorf("%s: %s", field, out)
		}
	}
}
