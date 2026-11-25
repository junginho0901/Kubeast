// Package nodecpu says what used one node's CPU between a window and the window of the same length right before it: the
// containers on the node across namespaces ranked by cores, each CPU's busy share and not only the average over them,
// throttling and the time spent waiting for a CPU, and from those which containers to suspect and which to read as their
// victims. It parses the window, builds the PromQL and turns the reads into an answer; the caller runs the reads as the
// user. A signal that could not be read says so under not_run, so a missing metric does not read as a quiet node.
package nodecpu

import (
	"errors"
	"fmt"
	"math"
	"net"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/util/validation"
)

// MaxQueries bounds the store and metrics API reads of one answer.
const MaxQueries = 6

// The window's bounds: half an hour by default, at least five minutes, at most a day, and the window before it within
// the week Prometheus is read back. It is cut into at most MaxSteps steps of at least MinStep, so a short burst is not
// spread over the whole window; MinStep holds two samples of a metric scraped once a minute.
const (
	DefaultLength = 30 * time.Minute
	MinLength     = 5 * time.Minute
	MaxLength     = 24 * time.Hour
	MaxBack       = 7 * 24 * time.Hour
	MaxSteps      = 12
	MinStep       = 2 * time.Minute
)

var ErrInvalidRequest = errors.New("invalid node CPU request")

func invalid(format string, a ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrInvalidRequest, fmt.Sprintf(format, a...))
}

// Window is [Start, End) in Steps steps of Step; the window before it is the same Steps right before Start.
type Window struct {
	Start time.Time
	End   time.Time
	Step  time.Duration
	Steps int
}

// Length is End - Start.
func (w Window) Length() time.Duration { return w.End.Sub(w.Start) }

// BeforeStart is where the window before w starts.
func (w Window) BeforeStart() time.Time { return w.Start.Add(-w.Length()) }

// QueryStart is the first evaluation of a range query over both windows: every evaluation, Step apart up to End, looks
// back one Step, so together they cover [BeforeStart, End).
func (w Window) QueryStart() time.Time { return w.BeforeStart().Add(w.Step) }

// stepStart is where step i of both windows starts (0 is the first of the window before).
func (w Window) stepStart(i int) time.Time { return w.BeforeStart().Add(time.Duration(i) * w.Step) }

// ParseWindow reads start and end (RFC3339, both optional). The end defaults to now, cut to the minute so that the same
// question in the same minute is the same window; an end after now is now. The start defaults to DefaultLength before
// the end, and moves back less than MaxSteps seconds so that the steps are whole seconds.
func ParseWindow(start, end string, now time.Time) (Window, error) {
	return parseWindow(start, end, now, MaxSteps)
}

// parseWindow is ParseWindow with at most maxSteps steps in place of MaxSteps.
func parseWindow(start, end string, now time.Time, maxSteps int) (Window, error) {
	w := Window{End: now.Truncate(time.Minute)}
	if end != "" {
		t, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return w, invalid("end must be an RFC3339 time")
		}
		if t = t.Truncate(time.Second); t.Before(now) {
			w.End = t
		}
	}
	w.Start = w.End.Add(-DefaultLength)
	if start != "" {
		t, err := time.Parse(time.RFC3339, start)
		if err != nil {
			return w, invalid("start must be an RFC3339 time")
		}
		w.Start = t.Truncate(time.Second)
	}
	switch length := w.Length(); {
	case length <= 0:
		return w, invalid("start must be before end and before now")
	case length < MinLength:
		return w, invalid("the window is at least %s", MinLength)
	case length > MaxLength:
		return w, invalid("the window is at most %s", MaxLength)
	}
	w.Steps = min(maxSteps, int(w.Length()/MinStep))
	seconds := int64(w.Length() / time.Second)
	w.Step = time.Duration((seconds+int64(w.Steps)-1)/int64(w.Steps)) * time.Second
	w.Start = w.End.Add(-time.Duration(w.Steps) * w.Step)
	if now.Sub(w.BeforeStart()) > MaxBack {
		return w, invalid("the window and the one before it reach at most %s back", MaxBack)
	}
	return w, nil
}

var nodeNameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

// ParseNode checks the node is an object name (DNS-1123 subdomain) before it goes into a query.
func ParseNode(node string) error {
	if len(node) > 253 || !nodeNameRe.MatchString(node) {
		return invalid("node is not a node name")
	}
	return nil
}

// Selectors are the label matchers that pick a node's series: by the label node, and for a scrape that sets none by
// instance, the node's name or one of its addresses with or without a port, matched whole (the node drawer's rule).
func Selectors(node string, addresses []string) []string {
	hosts := []string{regexp.QuoteMeta(node)}
	for _, a := range addresses {
		if a == "" || a == node {
			continue
		}
		if ip := net.ParseIP(a); ip != nil && ip.To4() == nil {
			hosts = append(hosts, `\[`+regexp.QuoteMeta(a)+`\]`)
			continue
		}
		hosts = append(hosts, regexp.QuoteMeta(a))
	}
	return []string{
		"node=" + strconv.Quote(node),
		`node="",instance=~` + strconv.Quote("(?:"+strings.Join(hosts, "|")+")(?::[0-9]+)?"),
	}
}

// MaxPodSelectorBytes bounds PodSelector's matcher: ThrottledQuery holds it twice, escaping at most doubles it, and the
// request line stays under the 8 KiB many proxies in front of a store accept (MaxQueryBytes).
const MaxPodSelectorBytes = 1800

// MaxQueryBytes is what an escaped query may take of that request line, the rest being the path and the window.
const MaxQueryBytes = 7800

// PodSelector is the label matcher of pods by namespace and name, for a store whose series say nothing of the node: the
// pods started last first, since they are the likeliest to be what changed. It returns how many pods did not fit; ""
// without a pod. A name is not a node, so a series it matches counts only for the (namespace, name) pairs asked
// (Input.ByPods).
func PodSelector(pods []Pod) (selector string, left int) {
	newest := append([]Pod{}, pods...)
	sort.SliceStable(newest, func(i, j int) bool { return newest[i].startedLast().After(newest[j].startedLast()) })
	build := func(namespaces, names []string) string {
		return "namespace=~" + strconv.Quote(strings.Join(namespaces, "|")) + ",pod=~" + strconv.Quote(strings.Join(names, "|"))
	}
	var namespaces, names []string
	for _, p := range newest {
		ns, name := withMember(namespaces, regexp.QuoteMeta(p.Namespace)), withMember(names, regexp.QuoteMeta(p.Name))
		if len(build(ns, name)) > MaxPodSelectorBytes {
			left++
			continue
		}
		namespaces, names = ns, name
	}
	if len(names) == 0 {
		return "", left
	}
	sort.Strings(namespaces)
	return build(namespaces, names), left
}

func withMember(list []string, s string) []string {
	if slices.Contains(list, s) {
		return list
	}
	return append(list[:len(list):len(list)], s)
}

func stepText(w Window) string { return strconv.FormatInt(int64(w.Step/time.Second), 10) + "s" }

// either is fn over metric with matchers for each of the selectors, joined with or: the selectors exclude each other, so
// a series is in one of them.
func either(fn, metric, matchers string, selectors []string, w Window) string {
	parts := make([]string, 0, len(selectors))
	for _, s := range selectors {
		all := s
		if matchers != "" {
			all = matchers + "," + s
		}
		parts = append(parts, fn+"("+metric+"{"+all+"}["+stepText(w)+"])")
	}
	return strings.Join(parts, " or ")
}

const (
	containerMatchers = `container!="",container!="POD"`
	byContainer       = "by (namespace, pod, container)"
)

// UsageQuery is the cores each container used in each step. A cgroup scraped by two jobs, or held twice by a replicated
// store, counts once (max by id); the cgroups of one container's restarts add up.
func UsageQuery(w Window, selectors []string) string {
	return "sum " + byContainer + " (max by (namespace, pod, container, id, cpu) (" +
		either("rate", "container_cpu_usage_seconds_total", containerMatchers, selectors, w) + "))"
}

// ThrottledQuery is the share of a container's CPU periods in which its limit stopped it.
func ThrottledQuery(w Window, selectors []string) string {
	count := func(metric string) string {
		return "sum " + byContainer + " (max by (namespace, pod, container, id) (" + either("increase", metric, containerMatchers, selectors, w) + "))"
	}
	return count("container_cpu_cfs_throttled_periods_total") + " / (" + count("container_cpu_cfs_periods_total") + " > 0)"
}

// WaitingQuery is the share of the time some task of a container waited for a CPU (pressure stall information).
func WaitingQuery(w Window, selectors []string) string {
	return "max " + byContainer + " (" + either("rate", "container_pressure_cpu_waiting_seconds_total", containerMatchers, selectors, w) + ")"
}

// StealCPU is the cpu label CPUsQuery gives the share the hypervisor took.
const StealCPU = "steal"

// CPUsQuery is the busy share of each of the node's CPUs, from node-exporter or the OpenTelemetry hostmetrics receiver,
// and the average share stolen by the hypervisor (StealCPU).
func CPUsQuery(w Window, node string, selectors []string) string {
	hostmetrics := []string{"k8s_node_name=" + strconv.Quote(node)}
	steal := "avg(max by (cpu) (" + either("rate", "node_cpu_seconds_total", `mode="steal"`, selectors, w) + "))"
	return "sum by (cpu) (max by (cpu, mode) (" + either("rate", "node_cpu_seconds_total", `mode!~"idle|iowait|steal"`, selectors, w) + "))" +
		" or sum by (cpu) (max by (cpu, state) (" + either("rate", "system_cpu_time_seconds_total", `state!~"idle|wait|steal"`, hostmetrics, w) + "))" +
		` or label_replace(` + steal + `, "cpu", "` + StealCPU + `", "", "")`
}

// NodeWaitingQuery is the share of the time some task of the node waited for a CPU: node-exporter's, else the kubelet's
// for the root cgroup.
func NodeWaitingQuery(w Window, selectors []string) string {
	return "max(" + either("rate", "node_pressure_cpu_waiting_seconds_total", "", selectors, w) + ")" +
		" or max(" + either("rate", "container_pressure_cpu_waiting_seconds_total", `id="/"`, selectors, w) + ")"
}

// Series is one series of a range query: its labels and (unix seconds, value) points.
type Series struct {
	Labels map[string]string
	Points [][2]float64
}

// Grid is a value per step of both windows, the window before first; NaN where there is none.
type Grid []float64

func usable(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 }

// Grid puts a series' points on w's steps.
func (w Window) Grid(points [][2]float64) Grid {
	g := make(Grid, 2*w.Steps)
	for i := range g {
		g[i] = math.NaN()
	}
	end, step := w.End.Unix(), int64(w.Step/time.Second)
	for _, p := range points {
		back := end - int64(math.Round(p[0]))
		if back < 0 || back%step != 0 || !usable(p[1]) {
			continue
		}
		if i := len(g) - 1 - int(back/step); i >= 0 {
			g[i] = p[1]
		}
	}
	return g
}

// mean is g's mean over steps; a step with no value is left out, or counts as 0 with zero (a container that did not run
// used nothing). ok is false when no step has a value.
func (g Grid) mean(steps []int, zero bool) (mean float64, ok bool) {
	var sum float64
	n := 0
	for _, i := range steps {
		if i >= len(g) || math.IsNaN(g[i]) {
			continue
		}
		sum += g[i]
		n++
	}
	if n == 0 {
		return 0, false
	}
	if zero {
		n = len(steps)
	}
	return sum / float64(n), true
}

// peak is g's highest value over steps and the step it was in.
func (g Grid) peak(steps []int) (peak float64, at int, ok bool) {
	for _, i := range steps {
		if i < len(g) && !math.IsNaN(g[i]) && (!ok || g[i] > peak) {
			peak, at, ok = g[i], i, true
		}
	}
	return peak, at, ok
}

// Key is one container of a pod.
type Key struct{ Namespace, Pod, Container string }

func (k Key) target() string { return k.Namespace + "/" + k.Pod + "/" + k.Container }

// names: the key is of names Kubernetes lets a namespace, a pod and a container have. A scrape that honours the target's
// own labels can carry any text in them, and the answer's sentences and rows name the keys.
func (k Key) names() bool {
	return len(validation.IsDNS1123Label(k.Namespace)) == 0 && len(validation.IsDNS1123Subdomain(k.Pod)) == 0 && len(validation.IsDNS1123Label(k.Container)) == 0
}

// ByContainer is the grids of series by their namespace, pod and container labels, and how many series had labels that
// are not such names and were left out.
func ByContainer(w Window, series []Series) (grids map[Key]Grid, odd int) {
	grids = make(map[Key]Grid, len(series))
	for _, s := range series {
		k := Key{s.Labels["namespace"], s.Labels["pod"], s.Labels["container"]}
		if k.Namespace == "" || k.Pod == "" || k.Container == "" {
			continue
		}
		g := w.Grid(s.Points)
		if _, any := g.mean(allSteps(w), false); !any {
			continue
		}
		if !k.names() {
			odd++
			continue
		}
		grids[k] = g
	}
	return grids, odd
}

// Reaches: one of the series has a value in the window itself, not only in the window before.
func Reaches(w Window, usage map[Key]Grid) bool {
	for _, g := range usage {
		if _, ok := g.mean(steps(w.Steps, 2*w.Steps), false); ok {
			return true
		}
	}
	return false
}

func allSteps(w Window) []int {
	steps := make([]int, 2*w.Steps)
	for i := range steps {
		steps[i] = i
	}
	return steps
}
