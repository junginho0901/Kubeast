// Package anomaly ranks what differs in a namespace between a window and the window of the same length right before it:
// failing objects, container terminations by reason, restarts, CPU throttling and memory against the limit, error log
// shapes and counts, requests, errors and latency of the services' server spans, node pressure. It parses the window, builds the PromQL and turns the reads into findings; the caller runs the reads as the
// user. A check that could not run says why, so a missing source does not read as "normal".
package anomaly

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The checks, in the order a tie is broken.
const (
	CheckIssues          = "issues"
	CheckCrashReasons    = "crash_reasons"
	CheckRestarts        = "restarts"
	CheckMemoryNearLimit = "memory_near_limit"
	CheckCPUThrottling   = "cpu_throttling"
	CheckErrorLogShapes  = "error_log_patterns"
	CheckErrorLogCounts  = "error_log_counts"
	CheckTraceErrors     = "trace_errors"
	CheckTraceLatency    = "trace_latency"
	CheckTraceRequests   = "trace_requests"
	CheckNodePressure    = "node_pressure"
)

// Checks lists every check in tie order.
var Checks = []string{CheckIssues, CheckCrashReasons, CheckRestarts, CheckMemoryNearLimit, CheckCPUThrottling,
	CheckErrorLogShapes, CheckErrorLogCounts, CheckTraceErrors, CheckTraceLatency, CheckTraceRequests, CheckNodePressure}

// LogChecks are the checks that read the log store, TraceChecks those that read the trace store.
var (
	LogChecks   = []string{CheckErrorLogShapes, CheckErrorLogCounts}
	TraceChecks = []string{CheckTraceErrors, CheckTraceLatency, CheckTraceRequests}
)

const (
	VerdictAnomalous = "anomalous"
	VerdictNormal    = "normal"
	VerdictNotRun    = "not_run"
)

// Limits of one answer.
const (
	MaxFindings = 10
	MaxExamples = 3
	// summaryMax keeps one finding's line short: the answer is read by a model with a result limit.
	summaryMax = 160
)

// The window's bounds: an hour by default, at least five minutes (a shorter one compares noise), at most a day, and the
// window before it within the week the stores are read back.
const (
	DefaultLength = time.Hour
	MinLength     = 5 * time.Minute
	MaxLength     = 24 * time.Hour
	MaxBack       = 7 * 24 * time.Hour
)

// Thresholds, simple and said out loud: a count that at least doubles or appears, a throttled share of a quarter of the
// CPU periods, memory at nine tenths of the limit, and growth by half for a share already past its threshold before.
const (
	CountRatio    = 2.0
	ThrottleShare = 0.25
	MemoryShare   = 0.9
	GrowthRatio   = 1.5
)

var ErrInvalidRequest = errors.New("invalid anomaly request")

func invalid(format string, a ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrInvalidRequest, fmt.Sprintf(format, a...))
}

// Window is [Start, End).
type Window struct {
	Start time.Time
	End   time.Time
}

// Length is End - Start.
func (w Window) Length() time.Duration { return w.End.Sub(w.Start) }

// Before is the window of the same length that ends where w starts.
func (w Window) Before() Window { return Window{Start: w.Start.Add(-w.Length()), End: w.Start} }

// ParseWindow reads start and end (RFC3339, both optional). The end defaults to now, cut to the minute so that the same
// question in the same minute is the same window; an end after now is now. The start defaults to an hour before the end.
func ParseWindow(start, end string, now time.Time) (Window, error) {
	w := Window{End: now.Truncate(time.Minute)}
	if end != "" {
		t, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return w, invalid("end must be an RFC3339 time")
		}
		if t.Before(now) {
			w.End = t
		}
	}
	w.Start = w.End.Add(-DefaultLength)
	if start != "" {
		t, err := time.Parse(time.RFC3339, start)
		if err != nil {
			return w, invalid("start must be an RFC3339 time")
		}
		w.Start = t
	}
	switch length := w.Length(); {
	case length <= 0:
		return w, invalid("start must be before end and before now")
	case length < MinLength:
		return w, invalid("the window is at least %s", MinLength)
	case length > MaxLength:
		return w, invalid("the window is at most %s", MaxLength)
	}
	if now.Sub(w.Before().Start) > MaxBack {
		return w, invalid("the window and the one before it reach at most %s back", MaxBack)
	}
	return w, nil
}

// WorkloadKinds are the owners a pod can be narrowed to.
var WorkloadKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

var (
	objectNameRe    = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
	namespaceNameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
)

// ParseNamespace checks the namespace is a namespace name (DNS-1123 label) before it goes into a query.
func ParseNamespace(namespace string) error {
	if len(namespace) > 63 || !namespaceNameRe.MatchString(namespace) {
		return invalid("namespace is not a namespace name")
	}
	return nil
}

// Workload narrows the checks to one owner's pods.
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// ParseWorkload reads the optional workload: both or neither.
func ParseWorkload(kind, name string) (*Workload, error) {
	if kind == "" && name == "" {
		return nil, nil
	}
	if kind == "" || name == "" {
		return nil, invalid("workload_kind and workload_name go together")
	}
	if !WorkloadKinds[kind] {
		return nil, invalid("workload_kind is one of Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob")
	}
	if len(name) > 253 || !objectNameRe.MatchString(name) {
		return nil, invalid("workload_name is not an object name")
	}
	return &Workload{Kind: kind, Name: name}, nil
}

// OwnsPod reports whether a pod with these owner references (podrow's "owner_references") belongs to w: its own owner,
// or the ReplicaSet of a Deployment and the Job of a CronJob, which carry the owner's name and a suffix.
func (w *Workload) OwnsPod(owners []map[string]interface{}) bool {
	if w == nil {
		return true
	}
	for _, o := range owners {
		kind, _ := o["kind"].(string)
		name, _ := o["name"].(string)
		switch {
		case kind == w.Kind && name == w.Name:
			return true
		case w.Kind == "Deployment" && kind == "ReplicaSet" && strings.HasPrefix(name, w.Name+"-"):
			return true
		case w.Kind == "CronJob" && kind == "Job" && strings.HasPrefix(name, w.Name+"-"):
			return true
		}
	}
	return false
}

// podMatcher is the PromQL label matcher of w's pods by name — pods that are gone have no owner left to read.
func (w *Workload) podMatcher() string {
	if w == nil {
		return ""
	}
	return `,pod=~"` + strings.ReplaceAll(w.Name, ".", `\\.`) + `-.*"`
}

// Finding is one thing a check found, or one target it compared.
type Finding struct {
	Check    string   `json:"check"`
	Target   string   `json:"target"`
	Verdict  string   `json:"verdict"`
	Summary  string   `json:"summary"`
	Before   *float64 `json:"before,omitempty"`
	Now      *float64 `json:"now,omitempty"`
	Ratio    *float64 `json:"ratio,omitempty"`
	New      bool     `json:"new,omitempty"`
	Examples []string `json:"examples,omitempty"`
}

// CheckResult is what one check gives: findings, or the reason it did not run.
type CheckResult struct {
	Check    string
	Findings []Finding
	NotRun   string
}

// NotRun names a check that did not run and why.
type NotRun struct {
	Check  string `json:"check"`
	Reason string `json:"reason"`
}

// WindowJSON is a window as RFC3339 times.
type WindowJSON struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

func windowJSON(w Window) WindowJSON {
	return WindowJSON{Start: w.Start.UTC().Format(time.RFC3339), End: w.End.UTC().Format(time.RFC3339)}
}

// Result is the answer: the ranked findings, the checks that found nothing and the checks that did not run.
type Result struct {
	Namespace     string     `json:"namespace"`
	Workload      *Workload  `json:"workload,omitempty"`
	Window        WindowJSON `json:"window"`
	ComparedWith  WindowJSON `json:"compared_with"`
	Findings      []Finding  `json:"findings"`
	FindingsTotal int        `json:"findings_total"`
	Normal        []string   `json:"normal"`
	NotRun        []NotRun   `json:"not_run"`
	StoreQueries  int        `json:"store_queries"`
}

// Assemble ranks the anomalous findings of every check and keeps the first MaxFindings; a check with none is normal.
func Assemble(namespace string, wl *Workload, w Window, results []CheckResult, storeQueries int) Result {
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
	}
	Rank(found)
	out.FindingsTotal = len(found)
	if len(found) > MaxFindings {
		found = found[:MaxFindings]
	}
	out.Findings = append(out.Findings, found...)
	return out
}

func checkOrder(check string) int {
	for i, c := range Checks {
		if c == check {
			return i
		}
	}
	return len(Checks)
}

func value(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// Rank orders findings: what is new first, then the larger ratio, then the larger value, then the check order and the
// target, so the same reads give the same order.
func Rank(findings []Finding) {
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i], findings[j]
		if a.New != b.New {
			return a.New
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

func num(v float64) *float64 {
	v = math.Round(v*1000) / 1000
	return &v
}

func shorten(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= summaryMax {
		return s
	}
	cut := summaryMax
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// compare fills a finding's before, now, ratio and new from two values; before is nil when the window before had none.
func compare(f *Finding, before *float64, now float64) {
	f.Now = num(now)
	if before == nil || *before == 0 {
		if before != nil {
			f.Before = num(0)
		}
		f.New = now > 0
		return
	}
	f.Before = num(*before)
	f.Ratio = num(now / *before)
}

// countAnomalous: a count that appeared, or at least doubled.
func countAnomalous(before *float64, now float64) bool {
	if now <= 0 {
		return false
	}
	return before == nil || *before == 0 || now/(*before) >= CountRatio
}

// shareAnomalous: a share past its threshold that was under it before, was not there, or grew by half.
func shareAnomalous(before *float64, now, threshold float64) bool {
	if now < threshold {
		return false
	}
	return before == nil || *before < threshold || now/(*before) >= GrowthRatio
}
