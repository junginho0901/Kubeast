package nodecpu

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// Limits of one answer: the rows, and how many of them the roles may take.
const (
	MaxRows       = 12
	MaxAggressors = 3
	MaxVictims    = 5
	MaxOwnLimit   = 3
)

// Thresholds, simple and said out loud. A step is busy when one CPU is busy for nine tenths of it or all of them for
// eight tenths on average. A container grew when it uses a tenth of a core and half as much again more than before, and
// is a suspect when its owner also makes up a fifth of everything that grew. A container is a victim when it was not
// throttled and used 15% less, or waited for a CPU a tenth of the time and half as much again more than before.
const (
	CPUBusyShare  = 0.90
	NodeBusyShare = 0.80
	GrewCores     = 0.1
	GrewRatio     = 1.5
	GrewShare     = 0.2
	ThrottleNone  = 0.05
	ThrottleShare = 0.25
	WaitShare     = 0.10
	WaitRatio     = 1.5
	// WaitBusyShare stands for a busy CPU only where the CPUs' own series are missing: a container that waits this much
	// of a step and is not throttled waits for a CPU somebody else has.
	WaitBusyShare = 0.25
	DropRatio     = 0.85
	// DropMinCores keeps an idle container's noise from reading as a drop.
	DropMinCores = 0.005
)

// Roles of a row and of the node.
const (
	RoleAggressor = "suspected_aggressor"
	RoleVictim    = "suspected_victim"
	RoleOwnLimit  = "own_limit"

	NodeBusy    = "node_busy"
	NodeNotBusy = "node_not_busy"
	NodeUnknown = "node_unknown"
)

// Sources of the containers' cores.
const (
	SourcePrometheus = "prometheus"
	SourceMetricsAPI = "metrics_api"
	SourceNone       = "none"
)

// What not_run names.
const (
	WhatPrometheus  = "prometheus" // every signal below that Prometheus holds
	WhatUsage       = "container_cpu"
	WhatThrottled   = "throttling"
	WhatWaiting     = "waiting"
	WhatCPUs        = "per_cpu"
	WhatNodeWaiting = "node_waiting"
	WhatPods        = "pods"
	WhatCurrent     = "current_usage"
)

// Why a signal without a series did not run: no series is not a value of zero.
const (
	NoUsage       = "Prometheus holds no container_cpu_usage_seconds_total series of this node (by its node or instance label, or by its pods' names), or holds fewer than two samples a step"
	UsageEnded    = "the container_cpu_usage_seconds_total series of this node end before the window"
	NoThrottled   = "no container_cpu_cfs_periods_total series of this node: no container on it has a CPU limit, or the metric is not scraped"
	NoWaiting     = "no container_pressure_cpu_waiting_seconds_total series of this node: the kubelet exports it from Kubernetes 1.34 on cgroup v2 with PSI in the kernel, or it is not scraped"
	NoCPUs        = "no node_cpu_seconds_total (node-exporter) or system_cpu_time_seconds_total (hostmetrics) series in the window whose node label or instance is this node: one full CPU cannot be told from an average"
	NoNodeWaiting = "no node_pressure_cpu_waiting_seconds_total series of this node"
	OddLabels     = "series whose namespace, pod or container label is not a Kubernetes name were left out"
)

// NotRun names a signal that was not read and why.
type NotRun struct {
	What   string `json:"what"`
	Reason string `json:"reason"`
}

// Input is what the caller read as the user.
type Input struct {
	Node        string
	Window      Window
	Allocatable float64 // cores, 0 when not known
	Requests    string  // the node's CPU requests as kubectl describe node prints them, "" when not known
	// Pods are the node's pods the caller may list; PodsError is why they could not be listed.
	Pods      []Pod
	PodsError string
	// Readable says whether the caller may list the pods of a namespace: a series of a pod that is not in Pods is named
	// only there. nil: nowhere.
	Readable func(namespace string) bool
	// ByPods: the series were picked by pod name, so one of a pod that is not in Pods is another node's.
	ByPods                    bool
	Usage, Throttled, Waiting map[Key]Grid
	CPUs                      []Series
	NodeWaiting               Grid
	// Current and CurrentNode are the metrics API's values now, read when Usage could not be.
	Current     map[Key]float64
	CurrentNode *float64
	NotRun      []NotRun
	Queries     int
}

// WindowJSON is a window as RFC3339 times.
type WindowJSON struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// BusyCPU is the CPU of the node that was busiest in the compared steps.
type BusyCPU struct {
	CPU    string   `json:"cpu"`
	Share  float64  `json:"share"`
	Peak   float64  `json:"peak_share"`
	Before *float64 `json:"before_share,omitempty"`
}

// NodeState is the node's own line: its role, its CPUs and what it used outside the containers.
type NodeState struct {
	Target      string   `json:"target"`
	Role        string   `json:"role"`
	BusySince   string   `json:"busy_since,omitempty"`
	Allocatable *float64 `json:"allocatable_cores,omitempty"`
	Requests    string   `json:"cpu_requests,omitempty"`
	CPUs        int      `json:"cpus,omitempty"`
	// The average busy share of all CPUs in the compared steps and before, its highest step, and the busiest CPU.
	BusyAverage       *float64 `json:"busy_average,omitempty"`
	BusyAverageBefore *float64 `json:"busy_average_before,omitempty"`
	BusyAveragePeak   *float64 `json:"busy_average_peak,omitempty"`
	BusiestCPU        *BusyCPU `json:"busiest_cpu,omitempty"`
	Waiting           *float64 `json:"waiting,omitempty"`
	WaitingBefore     *float64 `json:"waiting_before,omitempty"`
	Steal             *float64 `json:"steal,omitempty"`
	// ContainersCores is every container together, Other what the node used beside them.
	ContainersCores *float64 `json:"containers_cores,omitempty"`
	OtherCores      *float64 `json:"other_cores,omitempty"`
	OtherBefore     *float64 `json:"other_before_cores,omitempty"`
}

// Compared says which steps the rows' cores are about and which they are compared with.
type Compared struct {
	Steps    int    `json:"steps"`
	From     string `json:"from"`
	To       string `json:"to"`
	WithFrom string `json:"with_from,omitempty"`
	WithTo   string `json:"with_to,omitempty"`
	Why      string `json:"why"`
}

// Row is one container. Shares are of the time (1 is all of it).
type Row struct {
	Rank            int      `json:"rank"`
	Target          string   `json:"target"`
	Owner           string   `json:"owner,omitempty"`
	Role            string   `json:"role,omitempty"`
	Cores           float64  `json:"cores"`
	Before          *float64 `json:"before_cores,omitempty"`
	Grew            *float64 `json:"grew_cores,omitempty"`
	Peak            *float64 `json:"peak_cores,omitempty"`
	New             bool     `json:"new,omitempty"` // no series before
	Request         string   `json:"request,omitempty"`
	Limit           string   `json:"limit,omitempty"`
	StartedAt       string   `json:"started_at,omitempty"`
	Throttled       *float64 `json:"throttled,omitempty"`
	ThrottledBefore *float64 `json:"throttled_before,omitempty"`
	Waiting         *float64 `json:"waiting,omitempty"`
	WaitingBefore   *float64 `json:"waiting_before,omitempty"`
	Gone            bool     `json:"gone,omitempty"` // ran here in the windows, not now
}

// Rest is what the rows leave out, as a total.
type Rest struct {
	Namespaces int      `json:"namespaces,omitempty"`
	Pods       int      `json:"pods,omitempty"`
	Containers int      `json:"containers"`
	Cores      float64  `json:"cores"`
	Before     *float64 `json:"before_cores,omitempty"`
	Why        string   `json:"why,omitempty"`
}

// Result is the answer.
type Result struct {
	Node            NodeState  `json:"node"`
	Window          WindowJSON `json:"window"`
	ComparedWith    WindowJSON `json:"compared_with"`
	StepSeconds     int        `json:"step_seconds"`
	Source          string     `json:"source"`
	Compared        *Compared  `json:"compared,omitempty"`
	Reading         []string   `json:"reading"`
	Containers      []Row      `json:"containers"`
	ContainersTotal int        `json:"containers_total"`
	NotListed       *Rest      `json:"not_listed,omitempty"`
	NotShown        *Rest      `json:"not_shown,omitempty"`
	NotRun          []NotRun   `json:"not_run"`
	CannotSay       []string   `json:"cannot_say"`
	StoreQueries    int        `json:"store_queries"`
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func num(v float64) *float64 {
	v = math.Round(v*1000) / 1000
	return &v
}

func percent(v float64) string { return fmt.Sprintf("%.0f%%", v*100) }

// container is one container's figures while the answer is made.
type container struct {
	key             Key
	named, gone     bool
	known           Container
	owner           string
	cores, before   float64
	had             bool // there was a series before
	grew            float64
	peak            float64
	ran             bool // a series in the compared steps
	throttled       *float64
	throttledBefore *float64
	waiting         *float64
	waitingBefore   *float64
	role            string
	rank            int
}

// notRunOrder is the order not_run lists the signals in, whatever order their reads ended in.
var notRunOrder = []string{WhatPrometheus, WhatUsage, WhatCPUs, WhatThrottled, WhatWaiting, WhatNodeWaiting, WhatPods, WhatCurrent}

// Analyze turns the reads into the answer.
func Analyze(in Input) Result {
	out := analyze(in)
	sort.SliceStable(out.NotRun, func(i, j int) bool {
		return slices.Index(notRunOrder, out.NotRun[i].What) < slices.Index(notRunOrder, out.NotRun[j].What)
	})
	return out
}

func analyze(in Input) Result {
	w := in.Window
	out := Result{
		Window: WindowJSON{rfc3339(w.Start), rfc3339(w.End)}, ComparedWith: WindowJSON{rfc3339(w.BeforeStart()), rfc3339(w.Start)},
		StepSeconds: int(w.Step / time.Second), Source: SourceNone, Reading: []string{}, Containers: []Row{},
		NotRun: append([]NotRun{}, in.NotRun...), CannotSay: []string{}, StoreQueries: in.Queries,
	}
	out.Node = NodeState{Target: "Node/" + in.Node, Role: NodeUnknown, Requests: in.Requests}
	if in.Allocatable > 0 {
		out.Node.Allocatable = num(in.Allocatable)
	}
	if in.PodsError != "" {
		out.NotRun = append(out.NotRun, NotRun{WhatPods, in.PodsError + " (no requests, limits or start times)"})
	}
	if in.ByPods {
		in.Usage, in.Throttled, in.Waiting = ofPods(in.Usage, in.Pods), ofPods(in.Throttled, in.Pods), ofPods(in.Waiting, in.Pods)
	}
	cpus := readCPUs(w, in.CPUs)
	if len(in.Usage) == 0 {
		analyzeCurrent(&out, in, cpus)
		return out
	}
	analyzeWindows(&out, in, cpus)
	return out
}

// ofPods are the series of pods.
func ofPods(series map[Key]Grid, pods []Pod) map[Key]Grid {
	on := podsByKey(pods)
	out := make(map[Key]Grid, len(series))
	for k, g := range series {
		if _, ok := on[[2]string{k.Namespace, k.Pod}]; ok {
			out[k] = g
		}
	}
	return out
}

// analyzeWindows compares the steps the node was busy (or the whole window when none was) with what came before them.
func analyzeWindows(out *Result, in Input, cpus cpuGrid) {
	w := in.Window
	out.Source = SourcePrometheus
	now, before := steps(w.Steps, 2*w.Steps), steps(0, w.Steps)
	sum := containersSum(w, in.Usage)
	busy, how := busySteps(in, cpus, sum)

	compare, base := now, before
	first := firstBusy(busy, w.Steps)
	isBusy := first >= 0
	if isBusy {
		base = steps(0, first)
		compare = nil
		for i := first; i < 2*w.Steps; i++ {
			if busy[i] {
				compare = append(compare, i)
			}
		}
		out.Node.Role, out.Node.BusySince = NodeBusy, rfc3339(w.stepStart(first))
	} else if cpus.known(now) {
		out.Node.Role = NodeNotBusy
	}
	// without a series before there is nothing to have grown from
	_, hasBase := sum.mean(base, false)
	out.Compared = compared(w, compare, base, isBusy)
	fillNode(&out.Node, in, cpus, sum, compare, base, now)

	all := containers(in, compare, base, now)
	var named, hidden []*container
	for _, c := range all {
		if c.named {
			named = append(named, c)
		} else {
			hidden = append(hidden, c)
		}
	}
	rankContainers(named)
	if isBusy && hasBase {
		suspects(all, named)
	}
	ownLimits(named)
	if isBusy && hasBase {
		victims(named, in)
	}
	out.ContainersTotal = len(named)
	listed := pick(named)
	for _, c := range listed {
		out.Containers = append(out.Containers, c.row(hasBase))
	}
	out.NotListed = rest(named, listed)
	out.NotShown = restHidden(hidden)
	if len(in.Throttled) == 0 && !said(out.NotRun, WhatThrottled) {
		out.NotRun = append(out.NotRun, NotRun{WhatThrottled, NoThrottled})
	}
	if len(in.Waiting) == 0 && !said(out.NotRun, WhatWaiting) {
		out.NotRun = append(out.NotRun, NotRun{WhatWaiting, NoWaiting})
	}
	missingNode(out, in, cpus)
	out.CannotSay = []string{
		fmt.Sprintf("a burst shorter than a step (%s) is averaged over it", w.Step),
		"this reads CPU only, and that two things happened together: contention for memory bandwidth, cache, disk or network, and what the containers did with the CPU, are not read",
	}
	if in.ByPods {
		out.CannotSay = append(out.CannotSay, "the series were picked by the names of the pods on the node now: a pod that is gone is not in them, and one that moved here counts where it ran before")
	}
	out.Reading = reading(out, in, named, how, hasBase)
}

// firstBusy is the first step of the busy run that reaches into the window (it may have begun in the window before), or
// -1 when no step of the window was busy.
func firstBusy(busy []bool, windowSteps int) int {
	for i := windowSteps; i < len(busy); i++ {
		if !busy[i] {
			continue
		}
		for i > 0 && busy[i-1] {
			i--
		}
		return i
	}
	return -1
}

// analyzeCurrent answers from the metrics API's current values: no window, so no growth and no role.
func analyzeCurrent(out *Result, in Input, cpus cpuGrid) {
	w := in.Window
	if !said(out.NotRun, WhatUsage) {
		out.NotRun = append(out.NotRun, NotRun{WhatUsage, NoUsage})
	}
	missingNode(out, in, cpus)
	now, before := steps(w.Steps, 2*w.Steps), steps(0, w.Steps)
	fillNode(&out.Node, in, cpus, nil, now, before, now)
	busy, _ := busySteps(in, cpus, nil)
	if cpus.known(now) {
		out.Node.Role = NodeNotBusy
		if first := firstBusy(busy, w.Steps); first >= 0 {
			out.Node.Role, out.Node.BusySince = NodeBusy, rfc3339(w.stepStart(first))
		}
		out.Reading = append(out.Reading, cpuLine(out.Node))
	}
	var named []*container
	var sum float64
	byPod := podsByKey(in.Pods)
	for k, cores := range in.Current {
		c := &container{key: k, named: true, cores: cores, peak: cores, ran: true}
		if p, ok := byPod[[2]string{k.Namespace, k.Pod}]; ok {
			c.owner, c.known = p.Owner, p.Containers[k.Container]
		}
		named = append(named, c)
		sum += cores
	}
	rankContainers(named)
	out.ContainersTotal = len(named)
	listed := pick(named)
	for _, c := range listed {
		out.Containers = append(out.Containers, c.currentRow())
	}
	out.NotListed = rest(named, listed)
	out.CannotSay = []string{
		"current values only (metrics-server's last sample): no window before, so nothing here says what grew or since when, and no role is given",
		"one full CPU, throttling and time spent waiting for a CPU are not in the metrics API",
	}
	if len(named) == 0 {
		if in.CurrentNode == nil {
			out.Reading = append(out.Reading, "No container CPU was read for this node, from Prometheus or the metrics API (not_run says why): this is not a quiet node, it is an unread one.")
			return
		}
	} else {
		out.Source = SourceMetricsAPI
		out.Node.ContainersCores = num(sum)
	}
	if in.CurrentNode != nil {
		out.Source = SourceMetricsAPI
		other := math.Max(0, *in.CurrentNode-sum)
		out.Node.OtherCores = num(other)
		if !cpus.known(now) {
			text := fmt.Sprintf("Current values: the node uses %s cores", cores(*in.CurrentNode))
			if in.Allocatable > 0 {
				share := *in.CurrentNode / in.Allocatable
				out.Node.BusyAverage = num(share)
				text += fmt.Sprintf(", %s of its allocatable %s", percent(share), cores(in.Allocatable))
				if share >= NodeBusyShare {
					out.Node.Role = NodeBusy
				}
			}
			out.Reading = append(out.Reading, text+fmt.Sprintf("; %s of them outside the containers listed here (system daemons, and pods you may not read).", cores(other)))
		}
	}
	if len(named) > 0 {
		out.Reading = append(out.Reading, "Largest now: "+topNames(named, 3)+". What each used before is not known here.")
	}
	if out.Node.Role == NodeUnknown {
		out.Reading = append(out.Reading, "An average under the limit does not rule out one full CPU.")
	}
}

func steps(from, to int) []int {
	out := make([]int, 0, max(0, to-from))
	for i := from; i < to; i++ {
		out = append(out, i)
	}
	return out
}

// said: not_run already says why what was not read.
func said(notRun []NotRun, what string) bool {
	for _, n := range notRun {
		if n.What == what || n.What == WhatPrometheus {
			return true
		}
	}
	return false
}

func missingNode(out *Result, in Input, cpus cpuGrid) {
	w := in.Window
	if !cpus.known(steps(w.Steps, 2*w.Steps)) && !said(out.NotRun, WhatCPUs) {
		out.NotRun = append(out.NotRun, NotRun{WhatCPUs, NoCPUs})
	}
	if _, ok := in.NodeWaiting.mean(steps(w.Steps, 2*w.Steps), false); !ok && !said(out.NotRun, WhatNodeWaiting) {
		out.NotRun = append(out.NotRun, NotRun{WhatNodeWaiting, NoNodeWaiting})
	}
}

// cpuGrid is the busy share of each CPU of the node, per step.
type cpuGrid struct {
	count    int
	per      map[string]Grid
	avg, top Grid
	steal    Grid
}

var cpuRe = regexp.MustCompile(`^[0-9]{1,5}$`)

// readCPUs reads CPUsQuery's series. node-exporter names the CPUs 0, 1 …, hostmetrics cpu0, cpu1 …: with both in the
// store, node-exporter's are read.
func readCPUs(w Window, series []Series) cpuGrid {
	c := cpuGrid{per: map[string]Grid{}}
	hostmetrics := map[string]Grid{}
	for _, s := range series {
		g := w.Grid(s.Points)
		if _, any := g.mean(allSteps(w), false); !any {
			continue
		}
		// a CPU is a number: the answer's sentences name it, and a scrape can carry any text in the label
		name, fromHostmetrics := strings.CutPrefix(s.Labels["cpu"], "cpu")
		switch {
		case name == StealCPU && !fromHostmetrics:
			c.steal = g
		case !cpuRe.MatchString(name):
		case fromHostmetrics:
			hostmetrics[name] = g
		default:
			c.per[name] = g
		}
	}
	if len(c.per) == 0 {
		c.per = hostmetrics
	}
	c.count = len(c.per)
	c.avg, c.top = w.Grid(nil), w.Grid(nil)
	for i := range c.avg {
		var sum float64
		n := 0
		for _, g := range c.per {
			if math.IsNaN(g[i]) {
				continue
			}
			sum += g[i]
			n++
			if math.IsNaN(c.top[i]) || g[i] > c.top[i] {
				c.top[i] = g[i]
			}
		}
		if n > 0 {
			c.avg[i] = sum / float64(n)
		}
	}
	return c
}

// known: the CPUs have a value in one of steps.
func (c cpuGrid) known(steps []int) bool {
	_, ok := c.avg.mean(steps, false)
	return ok
}

// busiest is the CPU with the highest mean share over the compared steps.
func (c cpuGrid) busiest(compare, base, now []int) *BusyCPU {
	best := ""
	var bestShare float64
	for name, g := range c.per {
		if m, ok := g.mean(compare, false); ok && (best == "" || m > bestShare || (m == bestShare && name < best)) {
			best, bestShare = name, m
		}
	}
	if best == "" {
		return nil
	}
	g := c.per[best]
	out := &BusyCPU{CPU: best, Share: *num(bestShare)}
	if p, _, ok := g.peak(now); ok {
		out.Peak = *num(p)
	}
	if m, ok := g.mean(base, false); ok {
		out.Before = num(m)
	}
	return out
}

func containersSum(w Window, usage map[Key]Grid) Grid {
	sum := w.Grid(nil)
	for _, g := range usage {
		for i, v := range g {
			if math.IsNaN(v) {
				continue
			}
			if math.IsNaN(sum[i]) {
				sum[i] = 0
			}
			sum[i] += v
		}
	}
	return sum
}

// How a busy step was told.
const (
	byCPU         = "cpu"
	byAllocatable = "allocatable"
	byWaiting     = "waiting"
)

// busySteps marks the steps the node was busy: by its CPUs' own series, else by all containers against the allocatable,
// else (one full CPU cannot be ruled out) by a container that waited for a CPU without being throttled.
func busySteps(in Input, cpus cpuGrid, sum Grid) (busy []bool, how string) {
	busy = make([]bool, 2*in.Window.Steps)
	if cpus.known(steps(in.Window.Steps, 2*in.Window.Steps)) {
		for i := range busy {
			busy[i] = cpus.top[i] >= CPUBusyShare || cpus.avg[i] >= NodeBusyShare
		}
		return busy, byCPU
	}
	any := false
	if in.Allocatable > 0 && sum != nil {
		for i := range sum {
			busy[i] = sum[i]/in.Allocatable >= NodeBusyShare
			any = any || (busy[i] && i >= in.Window.Steps)
		}
	}
	if any {
		return busy, byAllocatable
	}
	busy = make([]bool, 2*in.Window.Steps)
	for k, g := range in.Waiting {
		throttled := in.Throttled[k]
		for i, v := range g {
			if math.IsNaN(v) || v < WaitBusyShare {
				continue
			}
			if i < len(throttled) && throttled[i] >= ThrottleNone {
				continue
			}
			busy[i] = true
		}
	}
	return busy, byWaiting
}

func compared(w Window, compare, base []int, busy bool) *Compared {
	c := &Compared{Steps: len(compare), From: rfc3339(w.stepStart(compare[0])), To: rfc3339(w.stepStart(compare[len(compare)-1] + 1)),
		Why: "no step of the window was busy, or it is not known: the whole window against the window before it"}
	if busy {
		c.Why = "the steps the node was busy, against the steps before it got busy"
	}
	if len(base) > 0 {
		c.WithFrom, c.WithTo = rfc3339(w.stepStart(base[0])), rfc3339(w.stepStart(base[len(base)-1]+1))
	}
	return c
}

func fillNode(n *NodeState, in Input, cpus cpuGrid, sum Grid, compare, base, now []int) {
	n.CPUs = cpus.count
	if m, ok := cpus.avg.mean(compare, false); ok {
		n.BusyAverage = num(m)
	}
	if m, ok := cpus.avg.mean(base, false); ok {
		n.BusyAverageBefore = num(m)
	}
	if p, _, ok := cpus.avg.peak(now); ok {
		n.BusyAveragePeak = num(p)
	}
	n.BusiestCPU = cpus.busiest(compare, base, now)
	if m, ok := in.NodeWaiting.mean(compare, false); ok {
		n.Waiting = num(m)
	}
	if m, ok := in.NodeWaiting.mean(base, false); ok {
		n.WaitingBefore = num(m)
	}
	if m, ok := cpus.steal.mean(compare, false); ok {
		n.Steal = num(m)
	}
	total, ok := sum.mean(compare, false)
	if !ok {
		return
	}
	n.ContainersCores = num(total)
	if cpus.count == 0 {
		return
	}
	if m, ok := cpus.avg.mean(compare, false); ok {
		n.OtherCores = num(math.Max(0, m*float64(cpus.count)-total))
	}
	if m, ok := cpus.avg.mean(base, false); ok {
		if b, ok := sum.mean(base, false); ok {
			n.OtherBefore = num(math.Max(0, m*float64(cpus.count)-b))
		}
	}
}

func podsByKey(pods []Pod) map[[2]string]Pod {
	out := make(map[[2]string]Pod, len(pods))
	for _, p := range pods {
		out[[2]string{p.Namespace, p.Name}] = p
	}
	return out
}

// containers are the figures of every container with a series. A container is named when it is one of the node's pods
// the caller may list, or of a pod that is not there now in a namespace whose pods the caller may list; the others are
// only counted.
func containers(in Input, compare, base, now []int) []*container {
	byPod := podsByKey(in.Pods)
	readable := map[string]bool{}
	mayRead := func(ns string) bool {
		if in.Readable == nil {
			return false
		}
		may, asked := readable[ns]
		if !asked {
			may = in.Readable(ns)
			readable[ns] = may
		}
		return may
	}
	out := make([]*container, 0, len(in.Usage))
	for k, g := range in.Usage {
		c := &container{key: k}
		p, on := byPod[[2]string{k.Namespace, k.Pod}]
		switch {
		case on:
			c.named, c.owner, c.known = true, p.Owner, p.Containers[k.Container]
		case mayRead(k.Namespace):
			c.named, c.gone = true, in.PodsError == ""
		}
		c.cores, c.ran = g.mean(compare, true)
		c.before, c.had = g.mean(base, false)
		c.grew = c.cores - c.before
		c.peak, _, _ = g.peak(now)
		c.throttled, c.throttledBefore = shares(in.Throttled[k], compare, base)
		c.waiting, c.waitingBefore = shares(in.Waiting[k], compare, base)
		if !c.ran && !c.had {
			continue
		}
		out = append(out, c)
	}
	return out
}

func shares(g Grid, compare, base []int) (now, before *float64) {
	if m, ok := g.mean(compare, false); ok {
		now = &m
	}
	if m, ok := g.mean(base, false); ok {
		before = &m
	}
	return now, before
}

func rankContainers(cs []*container) {
	sort.Slice(cs, func(i, j int) bool {
		a, b := cs[i], cs[j]
		if a.cores != b.cores {
			return a.cores > b.cores
		}
		if a.peak != b.peak {
			return a.peak > b.peak
		}
		return a.key.target() < b.key.target()
	})
	for i, c := range cs {
		c.rank = i + 1
	}
}

// suspects gives RoleAggressor to the named containers that grew, the most first, when their owner's containers make up
// a fifth of all that grew on the node (the ones counted and not named too). One pod of many that grew alike is none.
func suspects(all, named []*container) {
	var total float64
	owners := map[string]float64{}
	for _, c := range all {
		if c.grew > 0 {
			total += c.grew
			owners[c.ownerKey()] += c.grew
		}
	}
	var grew []*container
	for _, c := range named {
		if c.grewMuch() && owners[c.ownerKey()] >= GrewShare*total {
			grew = append(grew, c)
		}
	}
	sort.SliceStable(grew, func(i, j int) bool { return grew[i].grew > grew[j].grew })
	for i, c := range grew {
		if i < MaxAggressors {
			c.role = RoleAggressor
		}
	}
}

func (c *container) ownerKey() string {
	if c.owner != "" {
		return c.key.Namespace + "/" + c.owner
	}
	return c.key.Namespace + "/Pod/" + c.key.Pod
}

func (c *container) grewMuch() bool {
	return c.grew >= GrewCores && (!c.had || c.cores >= GrewRatio*c.before)
}

// ownLimits gives RoleOwnLimit to the containers their own limit stopped, the most first: they are slow for a reason
// that is not a neighbour.
func ownLimits(named []*container) {
	var cs []*container
	for _, c := range named {
		if c.role == "" && c.throttled != nil && *c.throttled >= ThrottleShare {
			cs = append(cs, c)
		}
	}
	sort.SliceStable(cs, func(i, j int) bool { return *cs[i].throttled > *cs[j].throttled })
	for i, c := range cs {
		if i < MaxOwnLimit {
			c.role = RoleOwnLimit
		}
	}
}

// notThrottled: the container has no CPU limit, or its throttled share was read and is next to none. A limit whose
// throttling was not read is not known to be out of the way.
func (c *container) notThrottled() bool {
	if c.throttled != nil {
		return *c.throttled < ThrottleNone
	}
	return c.known.Known && c.known.Limit == ""
}

func (c *container) waitedMore() bool {
	return c.waiting != nil && *c.waiting >= WaitShare && (c.waitingBefore == nil || *c.waiting >= WaitRatio**c.waitingBefore)
}

func (c *container) usedLess() bool {
	return c.before >= DropMinCores && c.cores <= DropRatio*c.before
}

// victims gives RoleVictim to the containers that were there before the node got busy, still run, were not stopped by
// their own limit, and waited longer or used less while it was busy.
func victims(named []*container, in Input) {
	var cs []*container
	for _, c := range named {
		if c.role != "" || !c.ran || !c.had || c.grewMuch() || !c.notThrottled() || (!c.waitedMore() && !c.usedLess()) {
			continue
		}
		if in.PodsError == "" && c.known.StartedAt.IsZero() {
			continue // it does not run now (or is gone): it used less because it ended
		}
		cs = append(cs, c)
	}
	weight := func(c *container) float64 {
		drop := 0.0
		if c.usedLess() {
			drop = 1 - c.cores/c.before
		}
		if c.waitedMore() {
			return math.Max(drop, *c.waiting)
		}
		return drop
	}
	sort.SliceStable(cs, func(i, j int) bool { return weight(cs[i]) > weight(cs[j]) })
	for i, c := range cs {
		if i < MaxVictims {
			c.role = RoleVictim
		}
	}
}

// pick is the rows listed: those with a role, then the largest, MaxRows in all, in rank order.
func pick(named []*container) []*container {
	listed := make([]*container, 0, MaxRows)
	for _, c := range named {
		if c.role != "" && len(listed) < MaxRows {
			listed = append(listed, c)
		}
	}
	for _, c := range named {
		if c.role == "" && len(listed) < MaxRows {
			listed = append(listed, c)
		}
	}
	sort.SliceStable(listed, func(i, j int) bool { return listed[i].rank < listed[j].rank })
	return listed
}

// row is c's row over the windows; without a base there is nothing to say of what grew or is new.
func (c *container) row(hasBase bool) Row {
	r := c.currentRow()
	r.Role, r.Peak, r.Gone = c.role, num(c.peak), c.gone
	if hasBase {
		r.Grew, r.New = num(c.grew), !c.had
	}
	if c.had {
		r.Before = num(c.before)
	}
	r.Throttled, r.ThrottledBefore = rounded(c.throttled), rounded(c.throttledBefore)
	r.Waiting, r.WaitingBefore = rounded(c.waiting), rounded(c.waitingBefore)
	return r
}

func (c *container) currentRow() Row {
	r := Row{Rank: c.rank, Target: c.key.target(), Owner: c.owner, Cores: *num(c.cores)}
	if c.known.Known {
		r.Request, r.Limit = orNone(c.known.Request), orNone(c.known.Limit)
	}
	if !c.known.StartedAt.IsZero() {
		r.StartedAt = rfc3339(c.known.StartedAt)
	}
	return r
}

func rounded(p *float64) *float64 {
	if p == nil {
		return nil
	}
	return num(*p)
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func rest(named, listed []*container) *Rest {
	if len(named) == len(listed) {
		return nil
	}
	in := map[*container]bool{}
	for _, c := range listed {
		in[c] = true
	}
	out := &Rest{}
	var sum float64
	for _, c := range named {
		if !in[c] {
			out.Containers++
			sum += c.cores
		}
	}
	out.Cores = *num(sum)
	return out
}

func restHidden(hidden []*container) *Rest {
	if len(hidden) == 0 {
		return nil
	}
	namespaces, pods := map[string]bool{}, map[[2]string]bool{}
	var now, before float64
	for _, c := range hidden {
		namespaces[c.key.Namespace] = true
		pods[[2]string{c.key.Namespace, c.key.Pod}] = true
		now += c.cores
		before += c.before
	}
	return &Rest{Namespaces: len(namespaces), Pods: len(pods), Containers: len(hidden), Cores: *num(now), Before: num(before),
		Why: "pods in namespaces you may not read, counted and not named"}
}

func cores(v float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", v), "0"), ".")
}

func topNames(named []*container, n int) string {
	var out []string
	for i, c := range named {
		if i == n {
			break
		}
		out = append(out, c.key.target()+" "+cores(c.cores))
	}
	return strings.Join(out, ", ")
}

// cpuLine is the node's CPUs in words, from their own series.
func cpuLine(n NodeState) string {
	average := ""
	if n.BusyAverage != nil {
		average = fmt.Sprintf("the average over its %d CPUs was %s", n.CPUs, percent(*n.BusyAverage))
	}
	if n.Role != NodeBusy {
		line := "No CPU of the node was busy 90% of a step and the average stayed under 80%"
		if b := n.BusiestCPU; b != nil {
			line += fmt.Sprintf(" (CPU %s was the busiest, %s at its highest step)", b.CPU, percent(b.Peak))
		}
		return line + ": a full CPU does not explain a slowdown on this node in this window."
	}
	b := n.BusiestCPU
	if b == nil || b.Peak < CPUBusyShare {
		line := fmt.Sprintf("The node was busy from %s: %s", n.BusySince, average)
		if n.BusyAverageBefore != nil {
			line += fmt.Sprintf(" (%s before)", percent(*n.BusyAverageBefore))
		}
		return line + "."
	}
	line := fmt.Sprintf("The node was busy from %s: CPU %s was busy %s of the time at its highest step", n.BusySince, b.CPU, percent(b.Peak))
	if b.Before != nil {
		line += fmt.Sprintf(" (%s before)", percent(*b.Before))
	}
	line += ", and " + average
	if n.BusyAverage != nil && *n.BusyAverage < NodeBusyShare {
		line += ": one full CPU does not show in the average"
	}
	return line + "."
}

// reading is the answer in a few sentences, each from the figures beside it: the node, what grew on it, who was slowed.
func reading(out *Result, in Input, named []*container, how string, hasBase bool) []string {
	var lines []string
	n := out.Node
	busy := n.Role == NodeBusy
	switch {
	case busy && how == byAllocatable:
		lines = append(lines, fmt.Sprintf("The node was busy from %s: its containers used %s of its allocatable %s cores.", n.BusySince, cores(*n.ContainersCores), cores(in.Allocatable)))
	case busy && how == byWaiting:
		lines = append(lines, fmt.Sprintf("From %s containers waited for a CPU without being throttled: somebody else had the CPU they needed. Which CPU was full is not known (no per-CPU series).", n.BusySince))
	case n.Role == NodeUnknown:
		lines = append(lines, "Whether one CPU of the node was full is not known (no per-CPU series): an average that is not high does not rule it out, and no role is given.")
	default:
		lines = append(lines, cpuLine(n))
	}
	if n.Steal != nil && *n.Steal >= ThrottleNone {
		lines = append(lines, fmt.Sprintf("The hypervisor took %s of the node's CPU time (steal): a neighbour outside this cluster, or an instance out of CPU credits.", percent(*n.Steal)))
	}
	if !hasBase {
		lines = append(lines, "There is nothing before it to compare with (busy through both windows, or no series then), so nothing here says what grew: ask an earlier start.")
	}

	var grew, slowed, stopped, waited []string
	for _, c := range named {
		switch c.role {
		case RoleAggressor:
			grew = append(grew, c.grewText(in.Window))
		case RoleVictim:
			slowed = append(slowed, c.key.target())
		case RoleOwnLimit:
			stopped = append(stopped, fmt.Sprintf("%s (%s of its CPU periods)", c.key.target(), percent(*c.throttled)))
		default:
			if !busy && c.had && c.waitedMore() && c.notThrottled() && len(waited) < MaxVictims {
				waited = append(waited, c.key.target())
			}
		}
	}
	if busy && hasBase {
		if len(grew) > 0 {
			lines = append(lines, "Suspected aggressor: "+strings.Join(grew, "; ")+".")
		} else {
			lines = append(lines, "No one container you can read grew by a tenth of a core and a fifth of what grew: the load is spread over the node, or is in not_shown or other_cores.")
		}
		if h := out.NotShown; h != nil && h.Before != nil && h.Cores-*h.Before >= GrewCores {
			lines = append(lines, fmt.Sprintf("Pods in %d namespaces you may not read grew by %s cores together.", h.Namespaces, cores(h.Cores-*h.Before)))
		}
		if n.OtherCores != nil && n.OtherBefore != nil && *n.OtherCores-*n.OtherBefore >= GrewCores {
			lines = append(lines, fmt.Sprintf("Outside the containers (system daemons, kernel) the node used %s cores more.", cores(*n.OtherCores-*n.OtherBefore)))
		}
	}
	if len(slowed) > 0 {
		lines = append(lines, "Suspected victims: "+strings.Join(slowed, ", ")+" waited longer or used less while the node was busy and were not throttled: look at the neighbours, not at these.")
	}
	if len(waited) > 0 {
		lines = append(lines, strings.Join(waited, ", ")+" waited longer for a CPU without being throttled: a container kept to a few CPUs (cpuset, affinity) waits with the node not full.")
	}
	if len(stopped) > 0 {
		lines = append(lines, "Stopped by their own CPU limit, not by a neighbour: "+strings.Join(stopped, ", ")+".")
	}
	return lines
}

// grewText is a suspect in words.
func (c *container) grewText(w Window) string {
	text := c.key.target()
	if c.owner != "" {
		text += " (" + c.owner + ")"
	}
	if c.had {
		text += fmt.Sprintf(" %s cores, %s before", cores(c.cores), cores(c.before))
	} else {
		text += fmt.Sprintf(" %s cores, not there before", cores(c.cores))
	}
	if c.known.Known {
		text += fmt.Sprintf(", request %s, limit %s", orNone(c.known.Request), orNone(c.known.Limit))
	}
	if !c.known.StartedAt.IsZero() {
		text += ", started " + rfc3339(c.known.StartedAt)
		if !c.known.StartedAt.Before(w.BeforeStart()) {
			text += " (inside the windows)"
		}
	}
	if c.gone {
		text += ", gone now"
	}
	return text
}
