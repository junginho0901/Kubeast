package anomaly

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// IssueRow is what the issue check (k8s.Issue) gives a row of: the object, how bad, why, and where it was asked for
// (with_since) from when the record shows it, with Before when it was there before the window (Window.WasThereBefore).
type IssueRow struct {
	Kind     string
	Name     string
	Severity string
	Reason   string
	Message  string
	Since    string
	Before   bool
}

// FromIssues is the "failing now" check: each critical or warning issue of an object in the namespace. It reads the
// objects as they are and nothing of the window before, so no finding is new. Nodes are the node check's and a list that
// failed (kind Collector) makes the answer partial, so neither is a finding here: with no finding the check did not run,
// else its findings come with the lists it could not read.
func FromIssues(rows []IssueRow, pods []map[string]interface{}, wl *Workload) CheckResult {
	names := podNames(pods, wl)
	r := CheckResult{Check: CheckIssues}
	var unread []string
	for _, row := range rows {
		switch {
		case row.Kind == "Collector":
			unread = append(unread, row.Name)
			continue
		case row.Kind == "Node" || (row.Severity != "critical" && row.Severity != "warning"):
			continue
		case wl != nil && !issueOfWorkload(row, wl, names):
			continue
		}
		f := Finding{Check: CheckIssues, Target: row.Kind + "/" + row.Name, Verdict: VerdictAnomalous,
			Summary: stateNow(row), Since: row.Since, AlreadyThere: row.Before, critical: row.Severity == "critical"}
		r.Findings = append(r.Findings, f)
	}
	sort.Strings(unread)
	if len(unread) > 0 {
		why := "these lists could not be read: " + strings.Join(unread, ", ")
		if len(r.Findings) == 0 {
			r.NotRun = why
		} else {
			r.Partial = why + "; the findings are from the other lists"
		}
	}
	return r
}

// stateNow is a state's summary. A critical one, which ranks beside what is new, says that nothing is known of the window
// before, or that it was there before it; a warning ranks last and claims nothing of it.
func stateNow(row IssueRow) string {
	now := row.Severity + " now: "
	switch {
	case row.Before:
		now = row.Severity + " now (" + ThereBefore + "): "
	case row.Severity == "critical":
		now = row.Severity + " now (" + NoEarlier + "): "
	}
	return shorten(now + strings.TrimSpace(row.Reason+" "+row.Message))
}

func issueOfWorkload(row IssueRow, wl *Workload, pods map[string]bool) bool {
	if row.Kind == "Pod" {
		return pods[row.Name]
	}
	return row.Kind == wl.Kind && row.Name == wl.Name
}

// podNames are the names of the pods wl owns (every pod without a workload).
func podNames(pods []map[string]interface{}, wl *Workload) map[string]bool {
	names := map[string]bool{}
	for _, p := range pods {
		if wl.OwnsPod(mapList(p, "owner_references")) {
			names[mapStr(p, "name")] = true
		}
	}
	return names
}

// FromNodeConditions is the node check: the conditions (NotReady, memory, disk or PID pressure, no network) of the nodes
// the namespace's pods run on, as they are now. It reads no CPU: a node whose CPU is full keeps its conditions.
// nodesError is why the nodes could not be listed (a grant limited to namespaces cannot list them).
func FromNodeConditions(rows []IssueRow, pods []map[string]interface{}, wl *Workload, nodesError string) CheckResult {
	r := CheckResult{Check: CheckNodeConditions}
	if nodesError != "" {
		r.NotRun = "the nodes could not be listed: " + nodesError
		return r
	}
	onNodes := map[string]bool{}
	for _, p := range pods {
		if node := mapStr(p, "node_name"); node != "" && wl.OwnsPod(mapList(p, "owner_references")) {
			onNodes[node] = true
		}
	}
	if len(onNodes) == 0 {
		r.NotRun = NoNodes
		return r
	}
	for _, row := range rows {
		if row.Kind != "Node" || !onNodes[row.Name] {
			continue
		}
		r.Findings = append(r.Findings, Finding{Check: CheckNodeConditions, Target: "Node/" + row.Name, Verdict: VerdictAnomalous,
			Summary: stateNow(row), critical: row.Severity == "critical"})
	}
	return r
}

// NoNodes and NoPods are why a check that reads the pods there are now did not run: nothing to read is not a normal value.
const (
	NoNodes = "no pod of the namespace (or workload) is on a node now, so no node was looked at"
	NoPods  = "the namespace (or workload) has no pods now, and a pod that is gone keeps no terminations"
)

type termination struct {
	at       time.Time
	pod      string
	ctr      string
	exitCode int
	// made: its pod was made in the window, so nothing is known of the pods it took the place of
	made bool
}

// madeIn reports whether a pod was made in the window or after it.
func madeIn(p map[string]interface{}, w Window) bool {
	created, err := time.Parse(time.RFC3339, mapStr(p, "created_at"))
	return err == nil && !created.Before(w.Start)
}

// hidesEarlier reports whether a container of a pod that was there before the window may have ended in the window before
// without its status showing it: the status keeps fewer ends (kept: the last, and the current one while it is terminated)
// than the container had, and the earliest it keeps is not from before that window, since one it lost came before those.
func hidesEarlier(c map[string]interface{}, kept []map[string]interface{}, w Window) bool {
	state := mapMap(c, "state")
	ended := mapInt(c, "restart_count")
	// a container that is not running ended once more than it was started again, unless it was never started
	if mapMap(state, "running") == nil && (len(kept) > 0 || ended > 0 || mapStr(mapMap(state, "waiting"), "reason") == "CrashLoopBackOff") {
		ended++
	}
	if ended <= len(kept) {
		return false
	}
	for _, t := range kept {
		if at, err := time.Parse(time.RFC3339, mapStr(t, "finished_at")); err == nil && at.Before(w.Before().Start) {
			return false
		}
	}
	return true
}

// FromCrashReasons counts the containers' terminations by reason (OOMKilled, Error …) in the window and in the window
// before it. A container shows its last termination only (and the current one while it is terminated), so a container
// that ended in both windows counts in the later one; the summary says so. A reason with no termination in the window
// before is new only when no container hides what it did there (hidesEarlier) and the pods that ended for it were there
// before the window; else the window before has no data for it.
func FromCrashReasons(pods []map[string]interface{}, wl *Workload, w Window) CheckResult {
	before := w.Before()
	now := map[string][]termination{}
	prev := map[string]float64{}
	read, hidden := 0, false
	for _, p := range pods {
		if !wl.OwnsPod(mapList(p, "owner_references")) {
			continue
		}
		read++
		pod, made := mapStr(p, "name"), madeIn(p, w)
		for _, c := range append(mapList(p, "containers"), mapList(p, "init_containers")...) {
			kept := []map[string]interface{}{}
			for _, t := range []map[string]interface{}{mapMap(mapMap(c, "state"), "terminated"), mapMap(mapMap(c, "last_state"), "terminated")} {
				if t != nil {
					kept = append(kept, t)
				}
			}
			hidden = hidden || (!made && hidesEarlier(c, kept, w))
			for _, t := range kept {
				reason := mapStr(t, "reason")
				at, err := time.Parse(time.RFC3339, mapStr(t, "finished_at"))
				if reason == "" || reason == "Completed" || err != nil {
					continue
				}
				switch {
				case !at.Before(w.Start) && at.Before(w.End):
					now[reason] = append(now[reason], termination{at: at, pod: pod, ctr: mapStr(c, "name"), exitCode: mapInt(t, "exit_code"), made: made})
				case !at.Before(before.Start) && at.Before(before.End):
					prev[reason]++
				}
			}
		}
	}
	r := CheckResult{Check: CheckCrashReasons}
	if read == 0 {
		r.NotRun = NoPods
		return r
	}
	reasons := make([]string, 0, len(now))
	for reason := range now {
		reasons = append(reasons, reason)
	}
	sort.Strings(reasons)
	for _, reason := range reasons {
		list := now[reason]
		sort.Slice(list, func(i, j int) bool { return list[i].at.After(list[j].at) })
		count := float64(len(list))
		v, known := prev[reason], !hidden
		for _, t := range list {
			known = known && !t.made
		}
		var b *float64
		if v > 0 || known {
			b = &v
		}
		f := Finding{Check: CheckCrashReasons, Target: reason, Verdict: VerdictNormal,
			Summary: shorten(fmt.Sprintf("%d container terminations with reason %s in the window, %s (the last termination of each container)", len(list), reason, earlierText(b, "%g in the window before")))}
		if countAnomalous(b, count) {
			f.Verdict = VerdictAnomalous
		}
		compare(&f, b, count)
		for _, t := range list {
			f.pods = append(f.pods, t.pod)
		}
		for i, t := range list {
			if i == MaxExamples {
				break
			}
			f.Examples = append(f.Examples, fmt.Sprintf("%s/%s exit %d at %s", t.pod, t.ctr, t.exitCode, t.at.UTC().Format(time.RFC3339)))
		}
		r.Findings = append(r.Findings, f)
	}
	return r
}

// Sample is one series of an instant query: its labels and value.
type Sample struct {
	Labels map[string]string
	Value  float64
}

// Query is one PromQL expression of a check, run at the end of the window: its values over the window and, offset by the
// window's length, over the window before, told apart by WindowLabel (SplitWindows). One query reads both windows, so a
// metric check is one store query.
type Query struct {
	Check string
	Expr  string
}

// WindowLabel is the label a Query puts on its series: windowNow or windowBefore.
const (
	WindowLabel  = "kubeast_window"
	windowNow    = "now"
	windowBefore = "before"
)

// bothWindows is the query of expr (of an offset modifier, "" for none) over the window and the one of the same length,
// d, before it.
func bothWindows(expr func(offset string) string, d time.Duration) string {
	labelled := func(e, window string) string {
		return `label_replace(` + e + `, "` + WindowLabel + `", "` + window + `", "pod", ".*")`
	}
	return labelled(expr(""), windowNow) + " or " + labelled(expr(" offset "+seconds(d)), windowBefore)
}

// SplitWindows parts a Query's series into those of the window and those of the window before.
func SplitWindows(samples []Sample) (now, before []Sample) {
	for _, s := range samples {
		switch s.Labels[WindowLabel] {
		case windowNow:
			now = append(now, s)
		case windowBefore:
			before = append(before, s)
		}
	}
	return now, before
}

func seconds(d time.Duration) string { return fmt.Sprintf("%ds", int(d.Seconds())) }

// promString quotes a value for a PromQL matcher (an object name: no quote or backslash, checked before).
func promString(s string) string { return `"` + s + `"` }

// Queries are the PromQL of the metric checks over a window of length d: restarts from kube-state-metrics, the share of
// throttled CPU periods and the working set against the memory limit from cAdvisor and kube-state-metrics.
func Queries(namespace string, wl *Workload, d time.Duration) []Query {
	ns := `namespace=` + promString(namespace) + wl.podMatcher()
	ctr := ns + `,container!=""`
	r := seconds(d)
	exprs := []struct {
		check string
		expr  func(offset string) string
	}{
		{CheckRestarts, func(offset string) string {
			return `sum by (pod) (increase(kube_pod_container_status_restarts_total{` + ns + `}[` + r + `]` + offset + `))`
		}},
		{CheckMemoryNearLimit, func(offset string) string {
			return `max by (pod, container) (max_over_time(container_memory_working_set_bytes{` + ctr + `}[` + r + `]` + offset + `)) / ` +
				`max by (pod, container) (kube_pod_container_resource_limits{` + ns + `,resource="memory"}` + offset + ` > 0)`
		}},
		{CheckCPUThrottling, func(offset string) string {
			return `sum by (pod) (increase(container_cpu_cfs_throttled_periods_total{` + ctr + `}[` + r + `]` + offset + `)) / ` +
				`sum by (pod) (increase(container_cpu_cfs_periods_total{` + ctr + `}[` + r + `]` + offset + `) > 0)`
		}},
	}
	out := make([]Query, 0, len(exprs))
	for _, e := range exprs {
		out = append(out, Query{Check: e.check, Expr: bothWindows(e.expr, d)})
	}
	return out
}

func sampleKey(check string, labels map[string]string) string {
	if check == CheckMemoryNearLimit {
		return labels["pod"] + "/" + labels["container"]
	}
	return labels["pod"]
}

func sampleTarget(check string, labels map[string]string) string {
	if check == CheckMemoryNearLimit {
		return "Pod/" + labels["pod"] + " container " + labels["container"]
	}
	return "Pod/" + labels["pod"]
}

// NoSeries and NoSeriesNow are why a metric check with no series in the window did not run: no series is not a normal value.
const (
	NoSeries    = "Prometheus holds no series for this check in the namespace (its metric is not scraped there, or no pod ran)"
	NoSeriesNow = "Prometheus holds series for this check in the window before and none in the window (its pods are gone, or its metric is not scraped any more)"
)

// FromMetric compares one metric check's series over the window (now) with those over the window before (before).
func FromMetric(check string, now, before []Sample) CheckResult {
	prev := map[string]float64{}
	for _, s := range before {
		if usable(s.Value) {
			prev[sampleKey(check, s.Labels)] = s.Value
		}
	}
	read := make([]Sample, 0, len(now))
	for _, s := range now {
		if usable(s.Value) {
			read = append(read, s)
		}
	}
	switch {
	case len(read) == 0 && len(prev) == 0:
		return CheckResult{Check: check, NotRun: NoSeries}
	case len(read) == 0:
		return CheckResult{Check: check, NotRun: NoSeriesNow}
	}
	r := CheckResult{Check: check}
	for _, s := range read {
		var b *float64
		if v, ok := prev[sampleKey(check, s.Labels)]; ok {
			b = &v
		}
		f := Finding{Check: check, Target: sampleTarget(check, s.Labels), Verdict: VerdictNormal}
		switch check {
		case CheckRestarts:
			// increase() extrapolates, 1.0020 for one restart: both windows count whole restarts
			v := math.Round(s.Value)
			if b != nil {
				whole := math.Round(*b)
				b = &whole
			}
			if countAnomalous(b, v) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, v)
			f.Summary = fmt.Sprintf("%g restarts in the window, %s", v, earlierText(b, "%g in the window before"))
		case CheckMemoryNearLimit:
			if shareAnomalous(b, s.Value, MemoryShare) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, s.Value)
			f.Summary = fmt.Sprintf("working set peaked at %.0f%% of the memory limit, %s", s.Value*100, earlierText(percent(b), "%.0f%% before"))
		case CheckCPUThrottling:
			if shareAnomalous(b, s.Value, ThrottleShare) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, s.Value)
			f.Summary = fmt.Sprintf("%.0f%% of CPU periods throttled, %s", s.Value*100, earlierText(percent(b), "%.0f%% before"))
		}
		r.Findings = append(r.Findings, f)
	}
	return r
}

func usable(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 }

func percent(b *float64) *float64 {
	if b == nil {
		return nil
	}
	v := *b * 100
	return &v
}

func mapStr(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

func mapInt(m map[string]interface{}, key string) int {
	switch v := m[key].(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
}

func mapMap(m map[string]interface{}, key string) map[string]interface{} {
	if m == nil {
		return nil
	}
	v, _ := m[key].(map[string]interface{})
	return v
}

func mapList(m map[string]interface{}, key string) []map[string]interface{} {
	switch v := m[key].(type) {
	case []map[string]interface{}:
		return v
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(v))
		for _, item := range v {
			if mm, ok := item.(map[string]interface{}); ok {
				out = append(out, mm)
			}
		}
		return out
	}
	return nil
}
