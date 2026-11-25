package nodecpu

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

// scene is a node's reads for a half-hour window (12 steps of 150 s, the 12 before it first), steps 0 to 23.
type scene struct {
	in Input
}

const lateStep = 22 // the last five minutes

func newScene(t *testing.T) *scene {
	t.Helper()
	w, err := ParseWindow("", "", testNow)
	if err != nil {
		t.Fatal(err)
	}
	return &scene{in: Input{Node: "n1", Window: w, Allocatable: 8, Requests: "3 (37%)", Usage: map[Key]Grid{}, Throttled: map[Key]Grid{}, Waiting: map[Key]Grid{},
		Readable: func(string) bool { return true }}}
}

func (s *scene) grid(f func(step int) float64) Grid {
	g := s.in.Window.Grid(nil)
	for i := range g {
		g[i] = f(i)
	}
	return g
}

func (s *scene) pod(ns, name, owner, request, limit string, started time.Time) Key {
	s.in.Pods = append(s.in.Pods, Pod{Namespace: ns, Name: name, Owner: owner, Containers: map[string]Container{
		"main": {Known: true, Request: request, Limit: limit, StartedAt: started}}})
	return Key{ns, name, "main"}
}

func (s *scene) cpu(name string, f func(step int) float64) {
	g := s.grid(f)
	var points [][2]float64
	for i, v := range g {
		points = append(points, [2]float64{float64(s.in.Window.stepStart(i + 1).Unix()), v})
	}
	s.in.CPUs = append(s.in.CPUs, Series{Labels: map[string]string{"cpu": name}, Points: points})
}

func (s *scene) started(step int) time.Time { return s.in.Window.stepStart(step) }

var longAgo = testNow.Add(-72 * time.Hour)

func flat(v float64) func(int) float64 { return func(int) float64 { return v } }

// since is before until step, then after.
func since(step int, before, after float64) func(int) float64 {
	return func(i int) float64 {
		if i < step {
			return before
		}
		return after
	}
}

// from has no value before step (the container did not run).
func from(step int, v float64) func(int) float64 { return since(step, math.NaN(), v) }

// saturated is a batch Job that takes one of eight CPUs in the last five minutes while three services beside it, with
// small requests and limits far away, get a sliver of it.
func saturated(t *testing.T) *scene {
	s := newScene(t)
	job := s.pod("reports", "monthly-report-run-x", "Job/monthly-report-run", "500m", "", s.started(lateStep))
	s.in.Usage[job] = s.grid(from(lateStep, 0.99))
	for i, name := range []string{"search-1", "pricing-1", "thumbnails-1"} {
		k := s.pod("shop-03", name, "ReplicaSet/"+strings.TrimSuffix(name, "-1"), "20m", "1", longAgo)
		before := 0.03 - 0.008*float64(i)
		s.in.Usage[k] = s.grid(since(lateStep, before, before*0.7))
		s.in.Waiting[k] = s.grid(since(lateStep, 0.02, 0.6))
		s.in.Throttled[k] = s.grid(flat(0))
	}
	api := s.pod("kube-system", "kube-apiserver-n1", "Node/n1", "250m", "", longAgo)
	s.in.Usage[api] = s.grid(flat(0.35))
	idle := s.pod("shop-03", "storefront-1", "ReplicaSet/storefront", "10m", "100m", longAgo)
	s.in.Usage[idle] = s.grid(flat(0.01))
	s.in.Throttled[idle] = s.grid(flat(0))
	for c := 0; c < 8; c++ {
		if c == 1 {
			s.cpu("1", since(lateStep, 0.3, 1.0))
			continue
		}
		s.cpu(fmt.Sprint(c), flat(0.12))
	}
	s.in.NodeWaiting = s.grid(since(lateStep, 0.02, 0.7))
	return s
}

func rowOf(t *testing.T, r Result, target string) Row {
	t.Helper()
	for _, row := range r.Containers {
		if row.Target == target {
			return row
		}
	}
	t.Fatalf("no row of %s: %s", target, dump(r))
	return Row{}
}

func dump(r Result) string {
	b, _ := json.MarshalIndent(r, "", " ")
	return string(b)
}

func text(r Result) string { return strings.Join(r.Reading, "\n") }

func reasons(r Result) map[string]string {
	out := map[string]string{}
	for _, n := range r.NotRun {
		out[n.What] = n.Reason
	}
	return out
}

func TestOneFullCPUIsSeenThoughTheAverageIsLow(t *testing.T) {
	s := saturated(t)
	r := Analyze(s.in)
	if r.Source != SourcePrometheus || r.Node.Target != "Node/n1" || r.Node.Role != NodeBusy {
		t.Fatal(dump(r))
	}
	if b := r.Node.BusiestCPU; b == nil || b.CPU != "1" || b.Peak != 1 || b.Share != 1 || b.Before == nil || *b.Before != 0.3 {
		t.Fatalf("busiest CPU: %s", dump(r))
	}
	if r.Node.CPUs != 8 || r.Node.BusyAverage == nil || *r.Node.BusyAverage > 0.3 || *r.Node.Allocatable != 8 || r.Node.Requests != "3 (37%)" {
		t.Fatalf("node: %s", dump(r))
	}
	if r.Node.BusySince != rfc3339(s.started(lateStep)) || r.Compared.Steps != 2 || r.Compared.From != r.Node.BusySince || r.Compared.WithFrom != r.ComparedWith.Start {
		t.Fatalf("compared: %s", dump(r))
	}
	if !strings.Contains(text(r), "CPU 1 was busy 100%") || !strings.Contains(text(r), "one full CPU does not show in the average") {
		t.Fatal(text(r))
	}
	if *r.Node.Waiting != 0.7 || *r.Node.WaitingBefore != 0.02 {
		t.Fatalf("node waiting: %s", dump(r))
	}
}

func TestTheRowsAreRankedByCoresAcrossNamespacesWithWhatTheyAskAndWhenTheyStarted(t *testing.T) {
	s := saturated(t)
	r := Analyze(s.in)
	var got []string
	for i, row := range r.Containers {
		if row.Rank != i+1 {
			t.Errorf("rank %d at place %d", row.Rank, i+1)
		}
		got = append(got, strings.Split(row.Target, "/")[1])
	}
	if want := "monthly-report-run-x,kube-apiserver-n1,search-1,pricing-1,storefront-1,thumbnails-1"; strings.Join(got, ",") != want {
		t.Fatalf("order %v, want %s", got, want)
	}
	job := rowOf(t, r, "reports/monthly-report-run-x/main")
	if job.Role != RoleAggressor || !job.New || job.Before != nil || job.Cores != 0.99 || *job.Grew != 0.99 || *job.Peak != 0.99 ||
		job.Owner != "Job/monthly-report-run" || job.Request != "500m" || job.Limit != "none" || job.StartedAt != rfc3339(s.started(lateStep)) {
		t.Fatalf("%+v", job)
	}
	api := rowOf(t, r, "kube-system/kube-apiserver-n1/main")
	if api.Role != "" || api.New || *api.Before != 0.35 || *api.Grew != 0 {
		t.Fatalf("%+v", api)
	}
}

func TestASlowedContainerThatIsNotThrottledIsAVictimOfItsNeighbour(t *testing.T) {
	r := Analyze(saturated(t).in)
	for _, name := range []string{"search-1", "pricing-1", "thumbnails-1"} {
		row := rowOf(t, r, "shop-03/"+name+"/main")
		if row.Role != RoleVictim || *row.Waiting != 0.6 || *row.WaitingBefore != 0.02 || *row.Throttled != 0 || *row.Grew >= 0 {
			t.Errorf("%+v", row)
		}
	}
	if row := rowOf(t, r, "shop-03/storefront-1/main"); row.Role != "" {
		t.Errorf("a container whose use did not change has a role: %+v", row)
	}
	if !strings.Contains(text(r), "look at the neighbours, not at these") || !strings.Contains(text(r), "Suspected aggressor: reports/monthly-report-run-x/main (Job/monthly-report-run) 0.99 cores, not there before, request 500m, limit none, started") {
		t.Fatal(text(r))
	}
}

// Without pressure metrics a drop in use while the node was busy is enough, and the answer says the signal is not there.
func TestWithoutPressureMetricsAVictimIsReadFromWhatItUsed(t *testing.T) {
	s := saturated(t)
	s.in.Waiting = nil
	r := Analyze(s.in)
	if row := rowOf(t, r, "shop-03/search-1/main"); row.Role != RoleVictim || row.Waiting != nil {
		t.Fatalf("%+v", row)
	}
	if reasons(r)[WhatWaiting] != NoWaiting {
		t.Fatalf("not run: %+v", r.NotRun)
	}
}

// A service made minutes ago has no series in the window before: the quiet steps of the window itself are its base.
func TestAContainerYoungerThanTheWindowBeforeIsComparedWithTheStepsBeforeTheNodeGotBusy(t *testing.T) {
	s := saturated(t)
	k := Key{"shop-03", "search-1", "main"}
	for i := range s.in.Usage[k] {
		if i < lateStep-4 {
			s.in.Usage[k][i], s.in.Waiting[k][i] = math.NaN(), math.NaN()
		}
	}
	row := rowOf(t, Analyze(s.in), "shop-03/search-1/main")
	if row.New || row.Before == nil || *row.Before != 0.03 || row.Role != RoleVictim {
		t.Fatalf("%+v", row)
	}
}

func TestAContainerStoppedByItsOwnLimitIsNotAVictim(t *testing.T) {
	s := saturated(t)
	k := s.pod("shop-03", "worker-1", "ReplicaSet/worker", "100m", "200m", longAgo)
	s.in.Usage[k] = s.grid(since(lateStep, 0.2, 0.15))
	s.in.Throttled[k] = s.grid(since(lateStep, 0.1, 0.8))
	s.in.Waiting[k] = s.grid(since(lateStep, 0.1, 0.9))
	// a little throttling is not none
	half := s.pod("shop-03", "half-1", "ReplicaSet/half", "100m", "200m", longAgo)
	s.in.Usage[half] = s.grid(since(lateStep, 0.2, 0.1))
	s.in.Throttled[half] = s.grid(flat(0.1))
	r := Analyze(s.in)
	if row := rowOf(t, r, "shop-03/worker-1/main"); row.Role != RoleOwnLimit || *row.Throttled != 0.8 || *row.ThrottledBefore != 0.1 {
		t.Fatalf("%+v", row)
	}
	if row := rowOf(t, r, "shop-03/half-1/main"); row.Role != "" {
		t.Fatalf("%+v", row)
	}
	if !strings.Contains(text(r), "Stopped by their own CPU limit, not by a neighbour: shop-03/worker-1/main (80% of its CPU periods)") {
		t.Fatal(text(r))
	}
}

// A limit whose throttling is not known is not known to be out of the way; no limit cannot throttle.
func TestAVictimNeedsItsThrottlingKnownOrNoLimit(t *testing.T) {
	s := saturated(t)
	s.in.Throttled = nil
	r := Analyze(s.in)
	if row := rowOf(t, r, "shop-03/search-1/main"); row.Role != "" {
		t.Fatalf("a limit whose throttling was not read: %+v", row)
	}
	if reasons(r)[WhatThrottled] != NoThrottled {
		t.Fatalf("not run: %+v", r.NotRun)
	}
	for i := range s.in.Pods {
		if s.in.Pods[i].Name == "search-1" {
			s.in.Pods[i].Containers["main"] = Container{Known: true, Request: "20m", StartedAt: longAgo}
		}
	}
	if row := rowOf(t, Analyze(s.in), "shop-03/search-1/main"); row.Role != RoleVictim {
		t.Fatalf("no limit: %+v", row)
	}
}

// Waiting as long as before, an idle container's noise, a container that was not there before and one that itself took
// more are no victims.
func TestWhatIsNoVictim(t *testing.T) {
	for name, c := range map[string]struct{ usage, waiting func(int) float64 }{
		"waits as it did":                    {flat(0.2), flat(0.3)},
		"idle":                               {since(lateStep, 0.004, 0.001), flat(0)},
		"was not there before":               {from(lateStep, 0.02), from(lateStep, 0.8)},
		"took more itself, under the fifth":  {since(lateStep, 0.02, 0.15), since(lateStep, 0.02, 0.8)},
		"waited more, but for under a tenth": {flat(0.2), since(lateStep, 0.01, 0.08)},
	} {
		s := saturated(t)
		k := s.pod("shop", "other-1", "ReplicaSet/other", "20m", "", longAgo)
		s.in.Usage[k], s.in.Waiting[k] = s.grid(c.usage), s.grid(c.waiting)
		if row := rowOf(t, Analyze(s.in), "shop/other-1/main"); row.Role != "" {
			t.Errorf("%s: %+v", name, row)
		}
	}
}

func TestAContainerThatEndedUsedLessAndIsNoVictim(t *testing.T) {
	s := saturated(t)
	done := s.pod("reports", "done-1", "Job/done", "100m", "", time.Time{})
	s.in.Usage[done] = s.grid(func(i int) float64 {
		if i >= lateStep+1 {
			return math.NaN()
		}
		return since(lateStep, 0.2, 0.05)(i)
	})
	if row := rowOf(t, Analyze(s.in), "reports/done-1/main"); row.Role != "" {
		t.Fatalf("%+v", row)
	}
}

func TestANodeThatIsNotBusyGivesNoRole(t *testing.T) {
	s := saturated(t)
	s.in.CPUs = nil
	for c := 0; c < 8; c++ {
		s.cpu(fmt.Sprint(c), flat(0.4))
	}
	r := Analyze(s.in)
	if r.Node.Role != NodeNotBusy || r.Node.BusySince != "" {
		t.Fatal(dump(r))
	}
	for _, row := range r.Containers {
		if row.Role != "" {
			t.Errorf("%+v", row)
		}
	}
	// the whole windows are compared; what grew is still said
	if r.Compared.Steps != 12 || r.Compared.From != r.Window.Start || r.Compared.WithTo != r.Window.Start {
		t.Fatalf("%+v", r.Compared)
	}
	if row := rowOf(t, r, "reports/monthly-report-run-x/main"); !row.New || *row.Peak != 0.99 {
		t.Fatalf("%+v", row)
	}
	if !strings.Contains(text(r), "a full CPU does not explain a slowdown") || !strings.Contains(text(r), "a container kept to a few CPUs") {
		t.Fatal(text(r))
	}
}

// No per-CPU series: an average cannot rule one full CPU out, so the node is unknown unless something waited for a CPU.
func TestWithoutPerCPUSeriesTheNodeIsUnknownNotQuiet(t *testing.T) {
	s := saturated(t)
	s.in.CPUs, s.in.Waiting, s.in.NodeWaiting = nil, nil, nil
	r := Analyze(s.in)
	if r.Node.Role != NodeUnknown || r.Node.BusyAverage != nil || r.Node.BusiestCPU != nil || r.Node.CPUs != 0 {
		t.Fatal(dump(r))
	}
	for _, row := range r.Containers {
		if row.Role != "" {
			t.Errorf("a role without knowing the node was busy: %+v", row)
		}
	}
	if n := reasons(r); n[WhatCPUs] != NoCPUs || n[WhatNodeWaiting] != NoNodeWaiting || n[WhatWaiting] != NoWaiting {
		t.Fatalf("not run: %+v", r.NotRun)
	}
	if !strings.Contains(text(r), "does not rule it out") {
		t.Fatal(text(r))
	}
}

func TestWithoutPerCPUSeriesAContainerThatWaitsUnthrottledSaysSomebodyHasItsCPU(t *testing.T) {
	s := saturated(t)
	s.in.CPUs = nil
	r := Analyze(s.in)
	if r.Node.Role != NodeBusy || r.Node.BusySince != rfc3339(s.started(lateStep)) {
		t.Fatal(dump(r))
	}
	if rowOf(t, r, "reports/monthly-report-run-x/main").Role != RoleAggressor || rowOf(t, r, "shop-03/search-1/main").Role != RoleVictim {
		t.Fatal(dump(r))
	}
	if !strings.Contains(text(r), "Which CPU was full is not known") {
		t.Fatal(text(r))
	}
	// the same wait in a container its own limit stops says nothing about a neighbour
	for k := range s.in.Throttled {
		s.in.Throttled[k] = s.grid(flat(0.6))
	}
	if r := Analyze(s.in); r.Node.Role != NodeUnknown {
		t.Fatalf("throttled waiting: %s", dump(r))
	}
}

func TestWithoutPerCPUSeriesAllContainersAgainstTheAllocatable(t *testing.T) {
	s := saturated(t)
	s.in.CPUs = nil
	s.in.Allocatable = 1.5
	r := Analyze(s.in)
	if r.Node.Role != NodeBusy || !strings.Contains(text(r), "of its allocatable 1.5 cores") || rowOf(t, r, "reports/monthly-report-run-x/main").Role != RoleAggressor {
		t.Fatal(dump(r))
	}
}

func TestTheWholeNodeBusyIsToldFromTheAverage(t *testing.T) {
	s := saturated(t)
	s.in.CPUs = nil
	for c := 0; c < 8; c++ {
		s.cpu(fmt.Sprint(c), since(lateStep, 0.2, 0.85))
	}
	r := Analyze(s.in)
	if r.Node.Role != NodeBusy || *r.Node.BusyAverage != 0.85 || *r.Node.BusyAverageBefore != 0.2 || !strings.Contains(text(r), "the average over its 8 CPUs was 85% (20% before)") {
		t.Fatal(dump(r))
	}
}

// The CPU load of one pod of many that grew alike is nobody's fault alone; one owner's pods count together.
func TestALoadSpreadOverManyOwnersHasNoOneSuspect(t *testing.T) {
	s := newScene(t)
	s.cpu("0", since(lateStep, 0.2, 1))
	for i := 0; i < 10; i++ {
		k := s.pod("shop", fmt.Sprintf("app-%d", i), fmt.Sprintf("ReplicaSet/app-%d", i), "100m", "", longAgo)
		s.in.Usage[k] = s.grid(since(lateStep, 0.05, 0.25))
	}
	r := Analyze(s.in)
	for _, row := range r.Containers {
		if row.Role != "" {
			t.Errorf("%+v", row)
		}
	}
	if !strings.Contains(text(r), "the load is spread over the node") {
		t.Fatal(text(r))
	}
	for i := range s.in.Pods {
		s.in.Pods[i].Owner = "ReplicaSet/app"
	}
	r = Analyze(s.in)
	n := 0
	for _, row := range r.Containers {
		if row.Role == RoleAggressor {
			n++
		}
	}
	if n != MaxAggressors {
		t.Fatalf("%d suspects of one owner: %s", n, dump(r))
	}
}

// A suspect grew by a tenth of a core and half as much again: a small rise, or a large one of a container that used much
// before, is neither.
func TestASmallOrProportionateRiseIsNoSuspect(t *testing.T) {
	s := newScene(t)
	s.cpu("0", since(lateStep, 0.2, 1))
	small := s.pod("shop", "small-1", "ReplicaSet/small", "10m", "", longAgo)
	s.in.Usage[small] = s.grid(since(lateStep, 0.01, 0.09))
	if row := rowOf(t, Analyze(s.in), "shop/small-1/main"); row.Role != "" || *row.Grew != 0.08 {
		t.Fatalf("%+v", row)
	}
	large := s.pod("shop", "large-1", "ReplicaSet/large", "2", "", longAgo)
	s.in.Usage[large] = s.grid(since(lateStep, 2, 2.5))
	if row := rowOf(t, Analyze(s.in), "shop/large-1/main"); row.Role != "" || *row.Grew != 0.5 {
		t.Fatalf("%+v", row)
	}
	s.in.Usage[large] = s.grid(since(lateStep, 2, 3))
	if row := rowOf(t, Analyze(s.in), "shop/large-1/main"); row.Role != RoleAggressor {
		t.Fatalf("%+v", row)
	}
}

// A container that ran in half of the busy steps used half as much over them.
func TestStepsAContainerDidNotRunInCountAsZeroCores(t *testing.T) {
	s := saturated(t)
	k := s.pod("reports", "half-1", "Job/half", "100m", "", s.started(lateStep+1))
	s.in.Usage[k] = s.grid(from(lateStep+1, 0.8))
	row := rowOf(t, Analyze(s.in), "reports/half-1/main")
	if row.Cores != 0.4 || *row.Peak != 0.8 || !row.New {
		t.Fatalf("%+v", row)
	}
}

// The signals Prometheus holds are not said missing one by one when none of them was asked.
func TestAPrometheusThatWasNotReadIsSaidOnce(t *testing.T) {
	s := newScene(t)
	s.in.Usage, s.in.Waiting, s.in.Throttled = nil, nil, nil
	s.in.NotRun = []NotRun{{WhatPrometheus, "no Prometheus reaches this cluster"}}
	if r := Analyze(s.in); len(r.NotRun) != 1 || r.NotRun[0].What != WhatPrometheus {
		t.Fatalf("%+v", r.NotRun)
	}
}

func TestNotRunIsInOneOrderWhateverOrderTheReadsEnded(t *testing.T) {
	s := saturated(t)
	s.in.Throttled, s.in.Waiting, s.in.CPUs, s.in.NodeWaiting = nil, nil, nil, nil
	s.in.PodsError = "refused"
	s.in.NotRun = []NotRun{{WhatNodeWaiting, "e1"}, {WhatThrottled, "e2"}, {WhatCPUs, "e3"}, {WhatWaiting, "e4"}}
	var got []string
	for _, n := range Analyze(s.in).NotRun {
		got = append(got, n.What)
	}
	if strings.Join(got, ",") != "per_cpu,throttling,waiting,node_waiting,pods" {
		t.Fatalf("%v", got)
	}
}

// A node that was as busy in the window before got busy where its run began, not at the window's start.
func TestABusyRunThatBeganInTheWindowBeforeIsComparedWithWhatCameBeforeIt(t *testing.T) {
	s := saturated(t)
	for k, g := range s.in.Usage {
		if k.Namespace == "reports" {
			s.in.Usage[k] = s.grid(from(6, 0.99))
			continue
		}
		_ = g
	}
	s.in.CPUs = nil
	s.cpu("0", flat(0.1))
	s.cpu("1", since(6, 0.3, 1))
	r := Analyze(s.in)
	if r.Node.BusySince != rfc3339(s.started(6)) || r.Compared.Steps != 18 || r.Compared.WithTo != rfc3339(s.started(6)) {
		t.Fatalf("%+v %+v", r.Node, r.Compared)
	}
	if rowOf(t, r, "reports/monthly-report-run-x/main").Role != RoleAggressor {
		t.Fatal(dump(r))
	}
}

func TestBusyThroughBothWindowsHasNothingToCompareWith(t *testing.T) {
	s := saturated(t)
	s.in.CPUs = nil
	s.cpu("0", flat(0.97))
	r := Analyze(s.in)
	if r.Node.Role != NodeBusy || r.Compared.WithFrom != "" || !strings.Contains(text(r), "ask an earlier start") {
		t.Fatal(dump(r))
	}
	for _, row := range r.Containers {
		if row.Role != "" || row.New || row.Grew != nil {
			t.Errorf("a role or a rise with nothing to compare with: %+v", row)
		}
	}
}

// Namespaces the caller may not read are counted: no name of them is anywhere in the answer.
func TestNamespacesTheCallerMayNotReadAreCountedNotNamed(t *testing.T) {
	s := saturated(t)
	secret := Key{"payroll", "salary-run-1", "calc"}
	s.in.Usage[secret] = s.grid(since(lateStep, 0.1, 1.4))
	s.in.Usage[Key{"payroll", "salary-run-1", "proxy"}] = s.grid(flat(0.05))
	s.in.Usage[Key{"hr", "leave-api-1", "main"}] = s.grid(flat(0.02))
	s.in.Throttled[secret] = s.grid(flat(0.9))
	s.in.Waiting[secret] = s.grid(flat(0.9))
	s.in.Readable = func(ns string) bool { return ns != "payroll" && ns != "hr" }
	r := Analyze(s.in)
	if n := r.NotShown; n == nil || n.Namespaces != 2 || n.Pods != 2 || n.Containers != 3 || n.Cores != 1.47 || *n.Before != 0.17 {
		t.Fatalf("not shown: %s", dump(r))
	}
	out := dump(r)
	for _, word := range []string{"payroll", "salary", "calc", "proxy", "hr/", "leave-api"} {
		if strings.Contains(out, word) {
			t.Errorf("%q is in the answer", word)
		}
	}
	if !strings.Contains(text(r), "Pods in 2 namespaces you may not read grew by 1.3 cores together") {
		t.Fatal(text(r))
	}
	// what they grew by still counts in what grew, so a small grower is not made the suspect in their place
	if rowOf(t, r, "reports/monthly-report-run-x/main").Role != RoleAggressor {
		t.Fatal(dump(r))
	}
	s.in.Usage[secret] = s.grid(since(lateStep, 0.1, 7))
	if row := rowOf(t, Analyze(s.in), "reports/monthly-report-run-x/main"); row.Role != "" {
		t.Fatalf("%+v", row)
	}
}

func TestWithoutReadableNothingThatIsNotAPodOfTheNodeIsNamed(t *testing.T) {
	s := saturated(t)
	s.in.Usage[Key{"shop-03", "old-1", "main"}] = s.grid(flat(0.2))
	s.in.Readable = nil
	r := Analyze(s.in)
	if r.NotShown == nil || r.NotShown.Containers != 1 || strings.Contains(dump(r), "old-1") {
		t.Fatal(dump(r))
	}
}

// The node's pods could not be listed: the namespaces whose pods the caller may list are named, without what the pods say.
func TestPodsThatCouldNotBeListedLeaveTheNamesOfReadableNamespacesOnly(t *testing.T) {
	s := saturated(t)
	s.in.Pods = nil
	s.in.PodsError = "the pods on the node: forbidden"
	s.in.Readable = func(ns string) bool { return ns == "reports" }
	r := Analyze(s.in)
	if len(r.Containers) != 1 || r.Containers[0].Target != "reports/monthly-report-run-x/main" || r.Containers[0].Request != "" || r.Containers[0].Gone {
		t.Fatal(dump(r))
	}
	if strings.Contains(dump(r), "shop-03") || r.NotShown.Namespaces != 2 || !strings.Contains(reasons(r)[WhatPods], "forbidden") {
		t.Fatal(dump(r))
	}
}

func TestAPodThatRanHereAndIsGoneIsNamedAsGone(t *testing.T) {
	s := saturated(t)
	s.in.Usage[Key{"reports", "burst-1", "main"}] = s.grid(since(lateStep, math.NaN(), 0.8))
	row := rowOf(t, Analyze(s.in), "reports/burst-1/main")
	if !row.Gone || row.Role != RoleAggressor || row.Request != "" || row.StartedAt != "" {
		t.Fatalf("%+v", row)
	}
}

// Series picked by pod name may be of a pod with that name on another node, or in another namespace.
func TestSeriesPickedByPodNameCountOnlyForThePodsOfTheNode(t *testing.T) {
	s := saturated(t)
	s.in.ByPods = true
	elsewhere := Key{"other", "search-1", "main"}
	s.in.Usage[elsewhere] = s.grid(flat(3))
	s.in.Waiting[elsewhere] = s.grid(flat(0.9))
	r := Analyze(s.in)
	if strings.Contains(dump(r), "other/search-1") || r.NotShown != nil || r.ContainersTotal != 6 || *r.Node.ContainersCores > 2 {
		t.Fatal(dump(r))
	}
	// nor does what they waited for say the node was busy
	s.in.CPUs = nil
	for k := range s.in.Waiting {
		if k != elsewhere {
			delete(s.in.Waiting, k)
		}
	}
	if r := Analyze(s.in); r.Node.Role != NodeUnknown {
		t.Fatal(dump(r))
	}
	if !strings.Contains(strings.Join(r.CannotSay, "\n"), "picked by the names of the pods") {
		t.Fatalf("%v", r.CannotSay)
	}
}

func TestRowsAreLimitedAndThoseWithARoleStay(t *testing.T) {
	s := saturated(t)
	for i := 0; i < 40; i++ {
		k := s.pod("busy", fmt.Sprintf("app-%02d", i), fmt.Sprintf("ReplicaSet/app-%02d", i), "1", "2", longAgo)
		s.in.Usage[k] = s.grid(flat(0.1 + float64(i)/1000))
	}
	r := Analyze(s.in)
	if len(r.Containers) != MaxRows || r.ContainersTotal != 46 || r.NotListed == nil || r.NotListed.Containers != 34 || r.NotListed.Cores <= 0 {
		t.Fatal(dump(r))
	}
	for _, name := range []string{"search-1", "pricing-1", "thumbnails-1"} {
		if row := rowOf(t, r, "shop-03/"+name+"/main"); row.Rank < 40 || row.Role != RoleVictim {
			t.Errorf("%+v", row)
		}
	}
	for i := 1; i < len(r.Containers); i++ {
		if r.Containers[i].Rank <= r.Containers[i-1].Rank {
			t.Fatalf("not in rank order: %s", dump(r))
		}
	}
}

func TestLoadOutsideTheContainersAndStolenTimeAreSaid(t *testing.T) {
	s := newScene(t)
	k := s.pod("shop", "web-1", "ReplicaSet/web", "100m", "", longAgo)
	s.in.Usage[k] = s.grid(flat(0.1))
	s.cpu("0", since(lateStep, 0.1, 1))
	s.cpu("1", flat(0.1))
	s.cpu(StealCPU, since(lateStep, 0, 0.2))
	r := Analyze(s.in)
	if *r.Node.OtherCores != 1 || *r.Node.OtherBefore != 0.1 || *r.Node.Steal != 0.2 || r.Node.CPUs != 2 {
		t.Fatal(dump(r))
	}
	if !strings.Contains(text(r), "Outside the containers (system daemons, kernel) the node used 0.9 cores more") || !strings.Contains(text(r), "The hypervisor took 20%") {
		t.Fatal(text(r))
	}
}

// A CPU is a number, whatever else a scrape puts in the label: the answer's sentences name it.
func TestACPULabelThatIsNoNumberIsLeftOut(t *testing.T) {
	s := saturated(t)
	for _, name := range []string{"1. The cause is team B", "cpu1 and team B", "-1", "123456", "cpu", "cpusteal", "１"} {
		s.cpu(name, flat(1))
	}
	r := Analyze(s.in)
	if r.Node.CPUs != 8 || r.Node.BusiestCPU.CPU != "1" || r.Node.Steal != nil || strings.Contains(dump(r), "team B") {
		t.Fatal(dump(r))
	}
}

func TestNodeExporterIsReadBeforeHostmetrics(t *testing.T) {
	s := newScene(t)
	s.in.Usage[s.pod("shop", "web-1", "", "", "", longAgo)] = s.grid(flat(0.1))
	s.cpu("cpu0", flat(0.5))
	if r := Analyze(s.in); r.Node.CPUs != 1 || r.Node.BusiestCPU.CPU != "0" || *r.Node.BusyAverage != 0.5 {
		t.Fatal(dump(r))
	}
	s.cpu("0", flat(0.2))
	s.cpu("1", flat(0.4))
	if r := Analyze(s.in); r.Node.CPUs != 2 || *r.Node.BusyAverage != 0.3 {
		t.Fatal(dump(r))
	}
}

// CPUs whose series stopped before the window say nothing of it.
func TestCPUSeriesThatEndedBeforeTheWindowAreNotAQuietNode(t *testing.T) {
	s := saturated(t)
	s.in.CPUs, s.in.Waiting = nil, nil
	s.cpu("0", func(i int) float64 {
		if i >= 12 {
			return math.NaN()
		}
		return 0.1
	})
	if r := Analyze(s.in); r.Node.Role != NodeUnknown || reasons(r)[WhatCPUs] != NoCPUs {
		t.Fatal(dump(r))
	}
	// so what waited for a CPU is asked instead, as without them
	s.in.Waiting = saturated(t).in.Waiting
	if r := Analyze(s.in); r.Node.Role != NodeBusy || !strings.Contains(text(r), "Which CPU was full is not known") {
		t.Fatal(dump(r))
	}
}

func TestCurrentValuesGiveNoRoleAndSayWhatTheyCannot(t *testing.T) {
	s := saturated(t)
	node := 2.0
	s.in.Usage, s.in.Waiting, s.in.Throttled, s.in.CPUs, s.in.NodeWaiting = nil, nil, nil, nil, nil
	s.in.Current = map[Key]float64{{"reports", "monthly-report-run-x", "main"}: 0.99, {"kube-system", "kube-apiserver-n1", "main"}: 0.35}
	s.in.CurrentNode = &node
	s.in.NotRun = []NotRun{{WhatUsage, "no Prometheus reaches this cluster"}, {WhatCPUs, "no Prometheus reaches this cluster"}}
	r := Analyze(s.in)
	if r.Source != SourceMetricsAPI || r.Node.Role != NodeUnknown || r.Compared != nil || *r.Node.BusyAverage != 0.25 || *r.Node.OtherCores != 0.66 {
		t.Fatal(dump(r))
	}
	row := rowOf(t, r, "reports/monthly-report-run-x/main")
	if row.Rank != 1 || row.Role != "" || row.Grew != nil || row.New || row.Peak != nil || row.Request != "500m" || row.StartedAt == "" {
		t.Fatalf("%+v", row)
	}
	if !strings.Contains(strings.Join(r.CannotSay, "\n"), "current values only") || !strings.Contains(text(r), "What each used before is not known here") ||
		!strings.Contains(text(r), "does not rule out one full CPU") || reasons(r)[WhatUsage] != "no Prometheus reaches this cluster" {
		t.Fatal(dump(r))
	}
	node = 7
	if r := Analyze(s.in); r.Node.Role != NodeBusy || rowOf(t, r, "reports/monthly-report-run-x/main").Role != "" {
		t.Fatal(dump(r))
	}
}

// Containers from the metrics API, the node's CPUs from Prometheus: the node's state is known, the rows' history is not.
func TestCurrentValuesBesideTheNodesOwnCPUs(t *testing.T) {
	s := saturated(t)
	s.in.Usage = nil
	s.in.Current = map[Key]float64{{"reports", "monthly-report-run-x", "main"}: 0.99}
	r := Analyze(s.in)
	if r.Node.Role != NodeBusy || r.Node.BusiestCPU.CPU != "1" || r.Node.BusySince == "" || reasons(r)[WhatUsage] != NoUsage {
		t.Fatal(dump(r))
	}
	if !strings.Contains(text(r), "CPU 1 was busy 100%") {
		t.Fatal(text(r))
	}
}

func TestNothingReadIsNotAQuietNode(t *testing.T) {
	s := newScene(t)
	s.in.Usage = nil
	r := Analyze(s.in)
	if r.Source != SourceNone || r.Node.Role != NodeUnknown || len(r.Containers) != 0 || r.ContainersTotal != 0 || !strings.Contains(text(r), "it is an unread one") {
		t.Fatal(dump(r))
	}
	n := reasons(r)
	if n[WhatUsage] != NoUsage || n[WhatCPUs] != NoCPUs || n[WhatNodeWaiting] != NoNodeWaiting {
		t.Fatalf("%+v", r.NotRun)
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, empty := range []string{`"containers":[]`, `"containers_total":0`} {
		if !strings.Contains(string(b), empty) {
			t.Errorf("%s not in %s", empty, b)
		}
	}
}

func TestTheAnswerHoldsNoNaN(t *testing.T) {
	for name, in := range map[string]Input{"saturated": saturated(t).in, "empty": newScene(t).in} {
		if _, err := json.Marshal(Analyze(in)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestPodsFromRowsReadsRequestsLimitsStartsAndOwners(t *testing.T) {
	started := "2026-11-25T01:20:00Z"
	rows := []map[string]interface{}{{
		"namespace": "shop", "name": "web-1",
		"owner_references": []map[string]interface{}{{"kind": "Thing", "name": "x", "controller": false}, {"kind": "ReplicaSet", "name": "web", "controller": true}},
		"containers": []map[string]interface{}{
			{"name": "app", "resources": map[string]interface{}{"requests": map[string]string{"cpu": "250m", "memory": "1Gi"}, "limits": map[string]string{"memory": "1Gi"}},
				"state": map[string]interface{}{"running": map[string]interface{}{"started_at": started}}},
			{"name": "waits", "resources": map[string]interface{}{}, "state": map[string]interface{}{"waiting": map[string]interface{}{"reason": "CrashLoopBackOff"}}},
		},
		"init_containers": []map[string]interface{}{{"name": "mesh", "state": map[string]interface{}{"running": map[string]interface{}{"started_at": started}}}},
	}, {"name": "no-namespace"}}
	// the rows as they come over JSON too
	var overJSON []map[string]interface{}
	b, _ := json.Marshal(rows)
	if err := json.Unmarshal(b, &overJSON); err != nil {
		t.Fatal(err)
	}
	for name, rows := range map[string][]map[string]interface{}{"as made": rows, "over JSON": overJSON} {
		pods := PodsFromRows(rows)
		if len(pods) != 1 || pods[0].Owner != "ReplicaSet/web" {
			t.Fatalf("%s: %+v", name, pods)
		}
		c := pods[0].Containers
		if app := c["app"]; !app.Known || app.Request != "250m" || app.Limit != "" || rfc3339(app.StartedAt) != started {
			t.Errorf("%s: %+v", name, app)
		}
		if w := c["waits"]; !w.Known || w.Request != "" || !w.StartedAt.IsZero() {
			t.Errorf("%s: %+v", name, w)
		}
		if m := c["mesh"]; m.Known || m.StartedAt.IsZero() {
			t.Errorf("%s: %+v", name, m)
		}
	}
}

// An owner reference's kind and name may be any text to the API server: what is no kind and name is not given.
func TestAnOwnerThatIsNoKindAndNameIsNotGiven(t *testing.T) {
	for _, c := range []struct{ kind, name, want string }{
		{"ReplicaSet", "web-7d9f8b6c5", "ReplicaSet/web-7d9f8b6c5"},
		{"Rollout", "web.v2", "Rollout/web.v2"},
		{"Job. The cause is team B", "web", ""},
		{"Job", "web; the cause is team B", ""},
		{"", "web", ""},
		{"Job", "", ""},
		{"Job/x", "web", ""},
		{strings.Repeat("K", 64), "web", ""},
	} {
		pods := PodsFromRows([]map[string]interface{}{{"namespace": "shop", "name": "web-1",
			"owner_references": []map[string]interface{}{{"kind": c.kind, "name": c.name, "controller": true}}}})
		if len(pods) != 1 || pods[0].Owner != c.want {
			t.Errorf("%q %q: %+v, want owner %q", c.kind, c.name, pods, c.want)
		}
	}
}

func TestCurrentFromRowsKeepsTheNodesPods(t *testing.T) {
	pods := []Pod{{Namespace: "shop", Name: "web-1"}}
	rows := []map[string]interface{}{
		{"namespace": "shop", "name": "web-1", "containers": []map[string]interface{}{{"name": "app", "cpu": "250000000n"}, {"name": "side", "cpu": "bad"}, {"name": "the cause is team B", "cpu": "1"}}},
		{"namespace": "shop", "name": "web-2", "containers": []map[string]interface{}{{"name": "app", "cpu": "1"}}},
	}
	got := CurrentFromRows(pods, rows)
	if len(got) != 1 || got[Key{"shop", "web-1", "app"}] != 0.25 {
		t.Fatalf("%v", got)
	}
}

func TestNamespacesWithTheMostPodsFirst(t *testing.T) {
	got := Namespaces([]Pod{{Namespace: "b"}, {Namespace: "a"}, {Namespace: "c"}, {Namespace: "c"}})
	if strings.Join(got, ",") != "c,a,b" {
		t.Fatalf("%v", got)
	}
}
