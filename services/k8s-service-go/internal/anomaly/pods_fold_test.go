package anomaly

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/podrow"
)

// The pod checks over pods folded in a row at a time answer what they answered over the whole list of rows: random pods
// of several workloads (siblings among them), on nodes or none, made before or in the window, whose containers and init
// containers ended at the windows' bounds, at the same second or not at all, against copies of the checks as they read
// that list (listIssues, listNodeConditions, listCrashReasons).
func TestThePodChecksOverFoldedPodsAnswerAsOverTheWholeList(t *testing.T) {
	w := Window{Start: now.Add(-time.Hour), End: now}
	workloads := []*Workload{nil, {Kind: "Deployment", Name: "web"}, {Kind: "ReplicaSet", Name: "web-5d4f8c7b9"}, {Kind: "StatefulSet", Name: "db"},
		{Kind: "CronJob", Name: "report"}, {Kind: "Job", Name: "report-29123"}, {Kind: "DaemonSet", Name: "agent"}, {Kind: "Deployment", Name: "none"}}
	r := rand.New(rand.NewSource(7))
	compared, ended := 0, 0
	for round := range 400 {
		var rows []map[string]interface{}
		var names []string
		for i := range r.Intn(40) {
			p := randomPod(r, i, w)
			names = append(names, p.Name)
			rows = append(rows, podrow.Info(p))
		}
		issues := randomIssueRows(r, names)
		for _, wl := range workloads {
			pods := folded(rows, wl, w)
			for _, c := range []struct {
				check     string
				got, want CheckResult
			}{
				{CheckIssues, FromIssues(issues, pods), listIssues(issues, rows, wl)},
				{CheckNodeConditions, FromNodeConditions(issues, pods, ""), listNodeConditions(issues, rows, wl, "")},
				{CheckNodeConditions + " refused", FromNodeConditions(issues, pods, "forbidden"), listNodeConditions(issues, rows, wl, "forbidden")},
				{CheckCrashReasons, FromCrashReasons(pods), listCrashReasons(rows, wl, w)},
				{CheckCrashReasons + " asked again", FromCrashReasons(pods), listCrashReasons(rows, wl, w)},
			} {
				if !reflect.DeepEqual(c.got, c.want) {
					t.Fatalf("round %d, workload %+v, %s:\n folded %+v\n listed %+v", round, wl, c.check, c.got, c.want)
				}
				compared++
				if c.check == CheckCrashReasons {
					ended += len(c.want.Findings)
				}
			}
		}
	}
	// the rounds reached what they compare: findings of terminations, not only empty answers
	if ended < 200 {
		t.Fatalf("%d crash reason findings in %d comparisons: the random pods end too seldom to compare them", ended, compared)
	}
	t.Logf("%d comparisons, %d crash reason findings", compared, ended)
}

// randomPod is a pod of one of the workloads (or of none), with what the pod checks read set at random: its node,
// when it was made, its containers' states and restarts, its init containers (a sidecar among them) and their states.
func randomPod(r *rand.Rand, i int, w Window) *corev1.Pod {
	type owner struct{ kind, name, pod string }
	owners := []owner{
		{"ReplicaSet", "web-5d4f8c7b9", "web-5d4f8c7b9-%05d"},
		{"ReplicaSet", "webhook-6d4b9c", "webhook-6d4b9c-%05d"},
		{"StatefulSet", "db", "db-%d"},
		{"Job", "report-29123", "report-29123-%05d"},
		{"Job", "report-manual-1763880000", "report-manual-1763880000-%05d"},
		{"Job", "reporter-1", "reporter-1-%05d"},
		{"DaemonSet", "agent", "agent-%05d"},
		{"", "", "bare-%d"},
	}
	o := owners[r.Intn(len(owners))]
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf(o.pod, i), Namespace: "shop"}}
	if o.kind != "" {
		yes := true
		p.OwnerReferences = []metav1.OwnerReference{{Kind: o.kind, Name: o.name, Controller: &yes}}
		if r.Intn(8) == 0 {
			p.OwnerReferences = append([]metav1.OwnerReference{{Kind: "ConfigMap", Name: "holder"}}, p.OwnerReferences...)
		}
	}
	p.Spec.NodeName = []string{"", "n0", "n1", "n2", "n3"}[r.Intn(5)]
	p.CreationTimestamp = metav1.NewTime(randomTime(r, w))
	for c := range 1 + r.Intn(2) {
		name := fmt.Sprintf("c%d", c)
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name})
		if r.Intn(6) == 0 {
			continue // no status yet
		}
		p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{Name: name, RestartCount: int32(r.Intn(10)),
			State: randomState(r, w), LastTerminationState: randomEnd(r, w)})
	}
	for c := range r.Intn(3) {
		name := fmt.Sprintf("init%d", c)
		ic := corev1.Container{Name: name}
		if r.Intn(2) == 0 {
			always := corev1.ContainerRestartPolicyAlways
			ic.RestartPolicy = &always
		}
		p.Spec.InitContainers = append(p.Spec.InitContainers, ic)
		if r.Intn(4) == 0 {
			continue
		}
		p.Status.InitContainerStatuses = append(p.Status.InitContainerStatuses, corev1.ContainerStatus{Name: name, RestartCount: int32(r.Intn(4)),
			State: randomState(r, w), LastTerminationState: randomEnd(r, w)})
	}
	return p
}

// randomTime is one of the instants the checks tell apart: in the window, at its bounds and those of the window before,
// before both, a second after another (ties at the second), or never set.
func randomTime(r *rand.Rand, w Window) time.Time {
	b := w.Before()
	at := []time.Time{{}, w.End, w.End.Add(-time.Second), w.End.Add(-5 * time.Minute), w.End.Add(-5 * time.Minute), w.Start.Add(time.Minute),
		w.Start, w.Start.Add(-time.Second), b.Start.Add(10 * time.Minute), b.Start, b.Start.Add(-time.Second), b.Start.Add(-48 * time.Hour)}
	t := at[r.Intn(len(at))]
	if !t.IsZero() && r.Intn(3) == 0 {
		t = t.Add(time.Duration(r.Intn(1000)) * time.Millisecond)
	}
	return t
}

func randomState(r *rand.Rand, w Window) corev1.ContainerState {
	switch r.Intn(5) {
	case 0:
		return corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(randomTime(r, w))}}
	case 1:
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: []string{"CrashLoopBackOff", "ContainerCreating", ""}[r.Intn(3)]}}
	case 2:
		return randomEnd(r, w)
	case 3:
		return corev1.ContainerState{}
	}
	return corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
}

func randomEnd(r *rand.Rand, w Window) corev1.ContainerState {
	if r.Intn(4) == 0 {
		return corev1.ContainerState{}
	}
	return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: int32([]int{0, 1, 137, 143}[r.Intn(4)]),
		Reason: []string{"OOMKilled", "Error", "Completed", "", "ContainerCannotRun"}[r.Intn(5)], FinishedAt: metav1.NewTime(randomTime(r, w))}}
}

// randomIssueRows names some of the pods, some pods that are not there, the workloads, the nodes and lists that failed.
func randomIssueRows(r *rand.Rand, pods []string) []IssueRow {
	severity := func() string { return []string{"critical", "warning", "info"}[r.Intn(3)] }
	var rows []IssueRow
	for _, p := range pods {
		if r.Intn(3) == 0 {
			row := IssueRow{Kind: "Pod", Name: p, Severity: severity(), Reason: "CrashLoopBackOff", Message: "back-off"}
			if r.Intn(2) == 0 {
				row.Since, row.Before = "2026-11-14T20:00:00Z", r.Intn(2) == 0
			}
			rows = append(rows, row)
		}
	}
	for _, o := range []IssueRow{{Kind: "Pod", Name: "gone-1"}, {Kind: "Deployment", Name: "web"}, {Kind: "StatefulSet", Name: "db"},
		{Kind: "CronJob", Name: "report"}, {Kind: "Job", Name: "report-29123"}, {Kind: "Node", Name: "n1"}, {Kind: "Node", Name: "n3"},
		{Kind: "Node", Name: "n9"}, {Kind: "Collector", Name: "jobs"}} {
		if r.Intn(2) == 0 {
			o.Severity, o.Reason = severity(), "Unavailable"
			rows = append(rows, o)
		}
	}
	return rows
}

// listIssues, listPodNames, listNodeConditions and listCrashReasons are the checks as they read the whole list of pod
// rows before the rows were folded (7a58c7e04, checks.go FromIssues, podNames, FromNodeConditions,
// FromCrashReasons), kept to compare with.
func listIssues(rows []IssueRow, pods []map[string]interface{}, wl *Workload) CheckResult {
	names := listPodNames(pods, wl)
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

func listPodNames(pods []map[string]interface{}, wl *Workload) map[string]bool {
	names := map[string]bool{}
	for _, p := range pods {
		if wl.OwnsPod(mapList(p, "owner_references")) {
			names[mapStr(p, "name")] = true
		}
	}
	return names
}

func listNodeConditions(rows []IssueRow, pods []map[string]interface{}, wl *Workload, nodesError string) CheckResult {
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

func listCrashReasons(pods []map[string]interface{}, wl *Workload, w Window) CheckResult {
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
