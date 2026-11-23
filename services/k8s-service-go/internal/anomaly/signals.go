package anomaly

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The log and trace checks' thresholds: at least five lines of an error shape (Grafana Sift's minimum), at least 20
// server spans before a service's requests are compared, a share of five in a hundred failed spans, and a p90 that at
// least doubles to 100 ms or more (Tempo's first latency bucket).
const (
	MinLogLines   = 5
	MinRequests   = 20
	ErrorShare    = 0.05
	LatencyRatio  = 2.0
	LatencyFloor  = 0.1
	DropRatio     = 0.5
	patternTarget = 100
	patternMax    = 300
)

// ErrorLinePattern is what a log line holds to count as an error line (case ignored).
const ErrorLinePattern = "(?i)(error|exception|fatal|panic)"

var (
	errorWords  = regexp.MustCompile(ErrorLinePattern)
	errorLevels = map[string]bool{"error": true, "err": true, "fatal": true, "critical": true, "crit": true, "panic": true, "emerg": true, "alert": true}
)

// LogLabels are the log store's label names for a stream's pod and container (logsearch.Labels).
type LogLabels struct {
	Pod       string
	Container string
}

// LogSelector is the stream selector of the log checks: the store adds the cluster and namespace matchers, the
// workload its pods by name.
func LogSelector(l LogLabels, wl *Workload) string {
	if wl == nil {
		return "{}"
	}
	return "{" + l.Pod + "=~" + strconv.Quote(wl.PodPattern()) + "}"
}

// ErrorCountQuery counts the error lines of each container over the last d at each step.
func ErrorCountQuery(l LogLabels, wl *Workload, d time.Duration) string {
	return "sum by (" + l.Container + ") (count_over_time(" + LogSelector(l, wl) + " |~ " + strconv.Quote(ErrorLinePattern) + " [" + seconds(d) + "]))"
}

// PatternSample is one log shape from the store's pattern ingester and its samples, [unix seconds, lines].
type PatternSample struct {
	Pattern string
	Level   string
	Samples [][2]int64
}

// NoPatterns and NoPatternsBefore are why the shape check did not run: no shape at all is not a normal value, and
// shapes the store no longer holds for the window before would all read as new.
const (
	NoPatterns       = "the log store's pattern ingester holds no log shape for this namespace in the window or the one before (no logs sent there, or Loki runs without pattern_ingester)"
	NoPatternsBefore = "the log store's pattern ingester holds nothing for the window before (it keeps the last few hours), so the shapes are not compared"
)

func errorShape(level, pattern string) bool {
	switch l := strings.ToLower(strings.TrimSpace(level)); {
	case errorLevels[l]:
		return true
	case l == "" || l == "unknown":
		return errorWords.MatchString(pattern)
	}
	return false
}

func within(t time.Time, w Window) bool { return !t.Before(w.Start) && t.Before(w.End) }

func cutRunes(s string, n int) (string, bool) {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…", true
	}
	return s, false
}

// FromPatterns is the error shape check: the shapes Loki's pattern ingester found with an error level (or, with no
// level, an error word) and at least MinLogLines lines in the window, compared with the window before.
func FromPatterns(patterns []PatternSample, w Window) CheckResult {
	r := CheckResult{Check: CheckErrorLogShapes}
	before := w.Before()
	seen, seenBefore := false, false
	for _, p := range patterns {
		for _, s := range p.Samples {
			t := time.Unix(s[0], 0)
			seen = seen || within(t, w) || within(t, before)
			seenBefore = seenBefore || within(t, before)
		}
	}
	switch {
	case !seen:
		r.NotRun = NoPatterns
		return r
	case !seenBefore:
		r.NotRun = NoPatternsBefore
		return r
	}
	for _, p := range patterns {
		if !errorShape(p.Level, p.Pattern) {
			continue
		}
		var now, prev float64
		for _, s := range p.Samples {
			switch t := time.Unix(s[0], 0); {
			case within(t, w):
				now += float64(s[1])
			case within(t, before):
				prev += float64(s[1])
			}
		}
		if now < MinLogLines {
			continue
		}
		target, cut := cutRunes(strings.Join(strings.Fields(p.Pattern), " "), patternTarget)
		f := Finding{Check: CheckErrorLogShapes, Target: target, Verdict: VerdictNormal,
			Summary: fmt.Sprintf("%g lines of this shape in the window, %g in the window before", now, prev)}
		if p.Level != "" {
			f.Summary += " (level " + p.Level + ")"
		}
		if countAnomalous(&prev, now) {
			f.Verdict = VerdictAnomalous
		}
		compare(&f, &prev, now)
		if cut {
			whole, _ := cutRunes(p.Pattern, patternMax)
			f.Examples = []string{whole}
		}
		r.Findings = append(r.Findings, f)
	}
	return r
}

// FromLogCounts is the error line count check: each container's lines matching ErrorLinePattern in the window (now) and
// in the window before. It catches what is too rare for a shape (Loki gives shapes past 30 lines).
func FromLogCounts(now, before map[string]float64) CheckResult {
	r := CheckResult{Check: CheckErrorLogCounts}
	containers := make([]string, 0, len(now))
	for c := range now {
		containers = append(containers, c)
	}
	sort.Strings(containers)
	for _, c := range containers {
		v := math.Round(now[c])
		if v < MinLogLines {
			continue
		}
		prev := math.Round(before[c])
		target := "container " + c
		if c == "" {
			target = "containers without a name label"
		}
		f := Finding{Check: CheckErrorLogCounts, Target: target, Verdict: VerdictNormal,
			Summary: fmt.Sprintf("%g lines matching %s in the window, %g in the window before", v, ErrorLinePattern, prev)}
		if countAnomalous(&prev, v) {
			f.Verdict = VerdictAnomalous
		}
		compare(&f, &prev, v)
		r.Findings = append(r.Findings, f)
	}
	return r
}

// The trace checks' queries.
const (
	SignalRequests = "requests"
	SignalErrors   = "errors"
	SignalLatency  = "latency"
)

// TraceQuery is one TraceQL metrics query of the trace checks.
type TraceQuery struct {
	Signal string
	Query  string
}

// TraceQueries count each service's server spans and failed server spans and take their p90 duration at each step.
// The store adds the cluster and namespace; a workload narrows to its pods by k8s.pod.name, anchored for a Tempo that
// does not anchor a regular expression itself.
func TraceQueries(wl *Workload) []TraceQuery {
	pod := ""
	if wl != nil {
		pod = " && resource.k8s.pod.name =~ " + strconv.Quote("^(?:"+wl.PodPattern()+")$")
	}
	return []TraceQuery{
		{Signal: SignalRequests, Query: "{ kind = server" + pod + " } | count_over_time() by (resource.service.name)"},
		{Signal: SignalErrors, Query: "{ kind = server && status = error" + pod + " } | count_over_time() by (resource.service.name)"},
		{Signal: SignalLatency, Query: "{ kind = server" + pod + " } | quantile_over_time(duration, .9) by (resource.service.name)"},
	}
}

// TraceStep is the step of the trace queries over the window and the one before: a whole number of seconds, at least
// 15, that the window's start is a multiple of and that cuts the window in 4 to 120 steps, the largest such. The checks
// then read only the steps strictly inside each window, which do not reach the other window whether the store labels a
// step by its start or its end. No such step: the window's bounds are not on whole minutes.
func TraceStep(w Window) (time.Duration, bool) {
	length := int64(w.Length() / time.Second)
	start := w.Start.Unix()
	for n := int64(4); n <= 120; n++ {
		if length%n != 0 {
			continue
		}
		if s := length / n; s >= 15 && start%s == 0 {
			return time.Duration(s) * time.Second, true
		}
	}
	return 0, false
}

// TraceSeries is one service's points of a trace query, [unix seconds, value].
type TraceSeries struct {
	Service string
	Points  [][2]float64
}

// NoSpans is why a trace check did not run: no span is not a normal value.
const NoSpans = "the trace store holds no server spans for this namespace in the window or the one before (no traces sent, or spans without k8s.namespace.name or span kind)"

type traceWindows struct {
	now, before float64
	nowSeen     bool
	beforeSeen  bool
}

// split adds (or with max, keeps the largest of) each series' points strictly inside the window and the window before.
func split(series []TraceSeries, w Window, max bool) map[string]*traceWindows {
	out := map[string]*traceWindows{}
	before := w.Before()
	for _, s := range series {
		tw := out[s.Service]
		if tw == nil {
			tw = &traceWindows{}
			out[s.Service] = tw
		}
		for _, p := range s.Points {
			t := time.Unix(int64(p[0]), 0)
			v := p[1]
			if !usable(v) {
				continue
			}
			var dst *float64
			switch {
			case t.After(w.Start) && t.Before(w.End):
				dst, tw.nowSeen = &tw.now, true
			case t.After(before.Start) && t.Before(w.Start):
				dst, tw.beforeSeen = &tw.before, true
			default:
				continue
			}
			if max {
				*dst = math.Max(*dst, v)
			} else {
				*dst += v
			}
		}
	}
	return out
}

func services(m map[string]*traceWindows) []string {
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func serviceTarget(name string) string {
	if name == "" {
		return "spans without service.name"
	}
	return "service " + name
}

// FromTraceRequests compares each service's server spans in the window with the window before: appeared, doubled or
// halved, or gone.
func FromTraceRequests(requests []TraceSeries, w Window) CheckResult {
	r := CheckResult{Check: CheckTraceRequests}
	if len(requests) == 0 {
		r.NotRun = NoSpans
		return r
	}
	m := split(requests, w, false)
	for _, svc := range services(m) {
		tw := m[svc]
		now, prev := math.Round(tw.now), math.Round(tw.before)
		if now < MinRequests && prev < MinRequests {
			continue
		}
		f := Finding{Check: CheckTraceRequests, Target: serviceTarget(svc), Verdict: VerdictNormal,
			Summary: fmt.Sprintf("%g server spans in the window, %g in the window before", now, prev)}
		switch {
		case countAnomalous(&prev, now) && now >= MinRequests:
			f.Verdict = VerdictAnomalous
		case prev >= MinRequests && now/prev <= DropRatio:
			f.Verdict = VerdictAnomalous
			f.Summary += " (fewer than half)"
		}
		compare(&f, &prev, now)
		r.Findings = append(r.Findings, f)
	}
	return r
}

// FromTraceErrors compares each service's share of failed server spans (status error) in the window with the window
// before: past ErrorShare with at least MinLogLines failed spans, and under it before, or grown by half.
func FromTraceErrors(requests, errs []TraceSeries, w Window) CheckResult {
	r := CheckResult{Check: CheckTraceErrors}
	if len(requests) == 0 {
		r.NotRun = NoSpans
		return r
	}
	all, failed := split(requests, w, false), split(errs, w, false)
	for _, svc := range services(failed) {
		e, total := failed[svc], all[svc]
		if total == nil || total.now == 0 || e.now < MinLogLines {
			continue
		}
		share := e.now / total.now
		var prev *float64
		if total.before > 0 {
			v := e.before / total.before
			prev = &v
		}
		f := Finding{Check: CheckTraceErrors, Target: serviceTarget(svc), Verdict: VerdictNormal,
			Summary: fmt.Sprintf("%.1f%% of server spans failed (%g of %g) in the window, %s before", share*100, math.Round(e.now), math.Round(total.now), beforeText(percent(prev), "%.1f%%"))}
		if shareAnomalous(prev, share, ErrorShare) {
			f.Verdict = VerdictAnomalous
		}
		compare(&f, prev, share)
		r.Findings = append(r.Findings, f)
	}
	return r
}

// FromTraceLatency compares each service's slowest step p90 of its server spans in the window with the window before:
// doubled to LatencyFloor or more.
func FromTraceLatency(p90 []TraceSeries, w Window) CheckResult {
	r := CheckResult{Check: CheckTraceLatency}
	if len(p90) == 0 {
		r.NotRun = NoSpans
		return r
	}
	m := split(p90, w, true)
	for _, svc := range services(m) {
		tw := m[svc]
		if !tw.nowSeen || tw.now <= 0 {
			continue
		}
		var prev *float64
		if tw.beforeSeen && tw.before > 0 {
			v := tw.before
			prev = &v
		}
		f := Finding{Check: CheckTraceLatency, Target: serviceTarget(svc), Verdict: VerdictNormal,
			Summary: fmt.Sprintf("p90 of server spans up to %.0f ms in the window, %s before", tw.now*1000, beforeText(millis(prev), "%.0f ms"))}
		if prev != nil && tw.now >= LatencyFloor && tw.now / *prev >= LatencyRatio {
			f.Verdict = VerdictAnomalous
		}
		if prev != nil {
			compare(&f, prev, tw.now)
		} else {
			f.Now = num(tw.now)
		}
		r.Findings = append(r.Findings, f)
	}
	return r
}

func millis(b *float64) *float64 {
	if b == nil {
		return nil
	}
	v := *b * 1000
	return &v
}
