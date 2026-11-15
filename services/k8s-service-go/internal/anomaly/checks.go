package anomaly

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// IssueRow is what the issue check (k8s.Issue) gives a row of: the object, how bad, why.
type IssueRow struct {
	Kind     string
	Name     string
	Severity string
	Reason   string
	Message  string
}

// FromIssues is the "failing now" check: each critical or warning issue of an object in the namespace. Nodes are the
// node pressure check's and a list that failed (kind Collector) makes the answer partial, so neither is a finding here.
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
			Summary: shorten(row.Severity + ": " + strings.TrimSpace(row.Reason+" "+row.Message)), New: row.Severity == "critical"}
		r.Findings = append(r.Findings, f)
	}
	sort.Strings(unread)
	if len(r.Findings) == 0 && len(unread) > 0 {
		r.NotRun = "these lists could not be read: " + strings.Join(unread, ", ")
	}
	return r
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

// FromNodePressure is the node check: the node issues (NotReady, a pressure) of the nodes the namespace's pods run on.
// nodesError is why the nodes could not be listed (a grant limited to namespaces cannot list them).
func FromNodePressure(rows []IssueRow, pods []map[string]interface{}, wl *Workload, nodesError string) CheckResult {
	r := CheckResult{Check: CheckNodePressure}
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
	for _, row := range rows {
		if row.Kind != "Node" || !onNodes[row.Name] {
			continue
		}
		r.Findings = append(r.Findings, Finding{Check: CheckNodePressure, Target: "Node/" + row.Name, Verdict: VerdictAnomalous,
			Summary: shorten(strings.TrimSpace(row.Reason + " " + row.Message)), New: row.Severity == "critical"})
	}
	return r
}

type termination struct {
	at       time.Time
	pod      string
	ctr      string
	exitCode int
}

// FromCrashReasons counts the containers' terminations by reason (OOMKilled, Error …) in the window and in the window
// before it. A container shows its last termination only (and the current one while it is terminated), so a container
// that ended in both windows counts in the later one; the summary says so.
func FromCrashReasons(pods []map[string]interface{}, wl *Workload, w Window) CheckResult {
	before := w.Before()
	now := map[string][]termination{}
	prev := map[string]float64{}
	for _, p := range pods {
		if !wl.OwnsPod(mapList(p, "owner_references")) {
			continue
		}
		pod := mapStr(p, "name")
		for _, c := range append(mapList(p, "containers"), mapList(p, "init_containers")...) {
			for _, t := range []map[string]interface{}{mapMap(mapMap(c, "state"), "terminated"), mapMap(mapMap(c, "last_state"), "terminated")} {
				if t == nil {
					continue
				}
				reason := mapStr(t, "reason")
				at, err := time.Parse(time.RFC3339, mapStr(t, "finished_at"))
				if reason == "" || reason == "Completed" || err != nil {
					continue
				}
				switch {
				case !at.Before(w.Start) && at.Before(w.End):
					now[reason] = append(now[reason], termination{at: at, pod: pod, ctr: mapStr(c, "name"), exitCode: mapInt(t, "exit_code")})
				case !at.Before(before.Start) && at.Before(before.End):
					prev[reason]++
				}
			}
		}
	}
	r := CheckResult{Check: CheckCrashReasons}
	reasons := make([]string, 0, len(now))
	for reason := range now {
		reasons = append(reasons, reason)
	}
	sort.Strings(reasons)
	for _, reason := range reasons {
		list := now[reason]
		sort.Slice(list, func(i, j int) bool { return list[i].at.After(list[j].at) })
		count := float64(len(list))
		var b *float64
		if v, ok := prev[reason]; ok {
			b = &v
		} else {
			zero := 0.0
			b = &zero
		}
		f := Finding{Check: CheckCrashReasons, Target: reason, Verdict: VerdictNormal,
			Summary: shorten(fmt.Sprintf("%d container terminations with reason %s in the window, %d in the window before (the last termination of each container)", len(list), reason, int(*b)))}
		if countAnomalous(b, count) {
			f.Verdict = VerdictAnomalous
		}
		compare(&f, b, count)
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

// Query is one PromQL expression of a check, run at the end of the window and at the end of the window before it.
type Query struct {
	Check string
	Expr  string
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
	return []Query{
		{Check: CheckRestarts, Expr: `sum by (pod) (increase(kube_pod_container_status_restarts_total{` + ns + `}[` + r + `]))`},
		{Check: CheckMemoryNearLimit, Expr: `max by (pod, container) (max_over_time(container_memory_working_set_bytes{` + ctr + `}[` + r + `])) / ` +
			`max by (pod, container) (kube_pod_container_resource_limits{` + ns + `,resource="memory"} > 0)`},
		{Check: CheckCPUThrottling, Expr: `sum by (pod) (increase(container_cpu_cfs_throttled_periods_total{` + ctr + `}[` + r + `])) / ` +
			`sum by (pod) (increase(container_cpu_cfs_periods_total{` + ctr + `}[` + r + `]) > 0)`},
	}
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

// NoSeries is why a metric check with no series in either window did not run: no series is not a normal value.
const NoSeries = "Prometheus holds no series for this check in the namespace (its metric is not scraped there, or no pod ran)"

// FromMetric compares one metric check's series at the end of the window (now) and of the window before (before).
func FromMetric(check string, now, before []Sample) CheckResult {
	if len(now) == 0 && len(before) == 0 {
		return CheckResult{Check: check, NotRun: NoSeries}
	}
	prev := map[string]float64{}
	for _, s := range before {
		if usable(s.Value) {
			prev[sampleKey(check, s.Labels)] = s.Value
		}
	}
	r := CheckResult{Check: check}
	for _, s := range now {
		if !usable(s.Value) {
			continue
		}
		var b *float64
		if v, ok := prev[sampleKey(check, s.Labels)]; ok {
			b = &v
		}
		f := Finding{Check: check, Target: sampleTarget(check, s.Labels), Verdict: VerdictNormal}
		switch check {
		case CheckRestarts:
			v := math.Round(s.Value)
			if countAnomalous(b, v) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, v)
			f.Summary = fmt.Sprintf("%g restarts in the window, %s in the window before", v, beforeText(b, "%g"))
		case CheckMemoryNearLimit:
			if shareAnomalous(b, s.Value, MemoryShare) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, s.Value)
			f.Summary = fmt.Sprintf("working set peaked at %.0f%% of the memory limit, %s before", s.Value*100, beforeText(percent(b), "%.0f%%"))
		case CheckCPUThrottling:
			if shareAnomalous(b, s.Value, ThrottleShare) {
				f.Verdict = VerdictAnomalous
			}
			compare(&f, b, s.Value)
			f.Summary = fmt.Sprintf("%.0f%% of CPU periods throttled, %s before", s.Value*100, beforeText(percent(b), "%.0f%%"))
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

func beforeText(b *float64, format string) string {
	if b == nil {
		return "no series"
	}
	return fmt.Sprintf(format, *b)
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
