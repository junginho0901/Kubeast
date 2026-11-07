package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The Cluster View page's getPodHealth (podHealth.tsx) is checked against these
// cases by podHealth.cases.test.ts: the pod as formatPodDetail sends it and the
// level and reason podHealth gives. UPDATE_POD_HEALTH_CASES=1 writes the file;
// otherwise the test fails when the file is not what the code gives now.
const podHealthCasesFile = "../../../../frontend/src/pages/cluster-view/podHealth.cases.json"

func randomHealthPod(rng *rand.Rand, i int) *corev1.Pod {
	waiting := []string{"ContainerCreating", "PodInitializing", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "ContainerStatusUnknown", ""}
	terminated := []string{"Completed", "Error", "OOMKilled", "StartError", "ContainerCannotRun", "Succeeded"}
	phases := []corev1.PodPhase{corev1.PodRunning, corev1.PodRunning, corev1.PodPending, corev1.PodSucceeded, corev1.PodFailed, corev1.PodUnknown, ""}
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ns", Name: fmt.Sprintf("p-%04d", i), CreationTimestamp: metav1.NewTime(time.Unix(1_700_000_000, 0))},
		Status:     corev1.PodStatus{Phase: phases[rng.Intn(len(phases))]},
	}
	if rng.Intn(12) == 0 {
		p.Status.Reason = []string{"Evicted", "NodeLost", "Completed"}[rng.Intn(3)]
	}
	if rng.Intn(15) == 0 {
		p.DeletionTimestamp = &metav1.Time{Time: time.Unix(1_700_000_100, 0)}
	}
	state := func() corev1.ContainerState {
		switch rng.Intn(5) {
		case 0:
			return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: waiting[rng.Intn(len(waiting))]}}
		case 1:
			return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: terminated[rng.Intn(len(terminated))], ExitCode: int32(rng.Intn(3) * 137 / 2)}}
		default:
			return corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
		}
	}
	for c := 0; c < rng.Intn(3); c++ { // init containers
		name := fmt.Sprintf("init%d", c)
		p.Spec.InitContainers = append(p.Spec.InitContainers, corev1.Container{Name: name, Image: "x"})
		if rng.Intn(5) > 0 {
			p.Status.InitContainerStatuses = append(p.Status.InitContainerStatuses, corev1.ContainerStatus{Name: name, Ready: rng.Intn(2) == 0, State: state()})
		}
	}
	for c := 0; c < 1+rng.Intn(3); c++ {
		name := fmt.Sprintf("c%d", c)
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name, Image: "x"})
		if rng.Intn(6) > 0 {
			cs := corev1.ContainerStatus{Name: name, Ready: rng.Intn(3) > 0, State: state()}
			if rng.Intn(4) == 0 {
				p.Status.ContainerStatuses = append([]corev1.ContainerStatus{cs}, p.Status.ContainerStatuses...)
			} else {
				p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, cs)
			}
		}
	}
	return p
}

// randomSidecarPod is a pod with restartable init containers (sidecars) beside the plain ones, drawn from its own source
// so the cases above stay as they were.
func randomSidecarPod(rng *rand.Rand, i int) *corev1.Pod {
	p := randomHealthPod(rng, i)
	p.Name = fmt.Sprintf("s-%04d", i)
	always := corev1.ContainerRestartPolicyAlways
	for c := 0; c < 1+rng.Intn(2); c++ {
		name := fmt.Sprintf("side%d", c)
		p.Spec.InitContainers = append(p.Spec.InitContainers, corev1.Container{Name: name, Image: "x", RestartPolicy: &always})
		if rng.Intn(6) == 0 {
			continue
		}
		cs := corev1.ContainerStatus{Name: name, Ready: rng.Intn(3) > 0}
		if rng.Intn(4) > 0 {
			started := rng.Intn(4) > 0
			cs.Started = &started
		}
		switch rng.Intn(6) {
		case 0:
			cs.State.Waiting = &corev1.ContainerStateWaiting{Reason: []string{"CrashLoopBackOff", "PodInitializing", "ContainerCreating"}[rng.Intn(3)]}
		case 1:
			cs.State.Terminated = &corev1.ContainerStateTerminated{Reason: []string{"Error", "Completed"}[rng.Intn(2)], ExitCode: int32(rng.Intn(2))}
		default:
			cs.State.Running = &corev1.ContainerStateRunning{}
		}
		p.Status.InitContainerStatuses = append(p.Status.InitContainerStatuses, cs)
	}
	return p
}

type podHealthCase struct {
	Pod    map[string]interface{} `json:"pod"`
	Level  string                 `json:"level"`
	Reason string                 `json:"reason"`
}

func podHealthCases() []podHealthCase {
	rng := rand.New(rand.NewSource(7))
	sidecars := rand.New(rand.NewSource(17))
	levels := []string{"ok", "warn", "error"}
	keep := []string{"phase", "status", "status_reason", "deletion_timestamp"}
	var out []podHealthCase
	for i := 0; i < 900; i++ {
		var p *corev1.Pod
		if i < 600 {
			p = randomHealthPod(rng, i)
		} else {
			p = randomSidecarPod(sidecars, i)
		}
		m := formatPodDetail(p)
		slim := map[string]interface{}{}
		for _, k := range keep {
			if v, ok := m[k]; ok {
				slim[k] = v
			}
		}
		for _, k := range []string{"containers", "init_containers"} {
			var cs []map[string]interface{}
			for _, c := range m[k].([]map[string]interface{}) {
				sc := map[string]interface{}{"name": c["name"]}
				for _, f := range []string{"ready", "state", "restart_policy", "started"} {
					if v, ok := c[f]; ok {
						sc[f] = v
					}
				}
				cs = append(cs, sc)
			}
			slim[k] = cs
		}
		level, reason := podHealth(p)
		out = append(out, podHealthCase{Pod: slim, Level: levels[level], Reason: reason})
	}
	return out
}

func TestPodHealthFixture(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(podHealthCases()); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_POD_HEALTH_CASES") == "1" {
		if err := os.WriteFile(podHealthCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(podHealthCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_POD_HEALTH_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("podHealth.cases.json is not what podHealth gives now: rerun with UPDATE_POD_HEALTH_CASES=1 and check the page's test")
	}
}

// A sidecar is meant to keep running: up, it holds nothing back, and a pod whose containers run beside it is fine. Short
// of that the pod warns or errs as kubectl's STATUS and READY say, with the sidecar counted as a container.
func TestPodHealth_ASidecarThatIsUpIsNotAWarning(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	yes, no := true, false
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	waiting := func(reason string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}
	}
	initialized := []corev1.PodCondition{{Type: corev1.PodInitialized, Status: corev1.ConditionTrue}, {Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	pod := func(phase corev1.PodPhase, app corev1.ContainerStatus, side ...corev1.ContainerStatus) *corev1.Pod {
		app.Name = "app"
		p := &corev1.Pod{
			Spec:   corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}, InitContainers: []corev1.Container{{Name: "side", RestartPolicy: &always}}},
			Status: corev1.PodStatus{Phase: phase, Conditions: initialized, ContainerStatuses: []corev1.ContainerStatus{app}},
		}
		for _, s := range side {
			s.Name = "side"
			p.Status.InitContainerStatuses = append(p.Status.InitContainerStatuses, s)
		}
		return p
	}
	appUp := corev1.ContainerStatus{Ready: true, State: running}
	sideUp := corev1.ContainerStatus{Ready: true, Started: &yes, State: running}
	plainInit := pod(corev1.PodRunning, appUp, corev1.ContainerStatus{Ready: true, Started: &yes, State: running})
	plainInit.Spec.InitContainers[0].RestartPolicy = nil
	cases := []struct {
		name   string
		pod    *corev1.Pod
		level  uint8
		reason string
	}{
		{"its sidecar up and ready, its container running", pod(corev1.PodRunning, appUp, sideUp), podHealthOK, "Running"},
		{"its sidecar up but not ready: READY 1/2", pod(corev1.PodRunning, appUp, corev1.ContainerStatus{Started: &yes, State: running}), podHealthWarn, "NotReady"},
		{"its sidecar ready, its container not", pod(corev1.PodRunning, corev1.ContainerStatus{State: running}, sideUp), podHealthWarn, "NotReady"},
		{"its sidecar running, not yet started", pod(corev1.PodRunning, appUp, corev1.ContainerStatus{Started: &no, State: running}), podHealthWarn, "PodInitializing"},
		{"its sidecar with no started field", pod(corev1.PodRunning, appUp, corev1.ContainerStatus{State: running}), podHealthWarn, "PodInitializing"},
		{"its sidecar waiting to start", pod(corev1.PodRunning, appUp, corev1.ContainerStatus{State: waiting("PodInitializing")}), podHealthWarn, "PodInitializing"},
		{"its sidecar crashing", pod(corev1.PodRunning, appUp, corev1.ContainerStatus{Started: &no, State: waiting("CrashLoopBackOff")}), podHealthError, "CrashLoopBackOff"},
		{"its sidecar with no status yet", pod(corev1.PodRunning, appUp), podHealthWarn, "NotReady"},
		{"a plain init container still running holds it back", plainInit, podHealthWarn, "PodInitializing"},
	}
	for _, c := range cases {
		if l, r := podHealth(c.pod); l != c.level || r != c.reason {
			t.Errorf("%s: got %d %q, want %d %q", c.name, l, r, c.level, c.reason)
		}
	}
	// what the page reads to tell them apart comes with the row, and only for a sidecar
	row := formatPodDetail(pod(corev1.PodRunning, appUp, sideUp))["init_containers"].([]map[string]interface{})[0]
	if row["restart_policy"] != "Always" || row["started"] != true {
		t.Errorf("a sidecar's row: restart_policy %v, started %v", row["restart_policy"], row["started"])
	}
	plain := formatPodDetail(plainInit)["init_containers"].([]map[string]interface{})[0]
	if _, ok := plain["restart_policy"]; ok {
		t.Errorf("a plain init container's row has restart_policy %v", plain["restart_policy"])
	}
	if _, ok := plain["started"]; ok {
		t.Errorf("a plain init container's row has started %v", plain["started"])
	}
}

// Over the states a pod with a sidecar goes through, Cluster View calls it fine exactly when kubectl prints Running with
// every container ready.
func TestPodHealth_FineIsWhatKubectlPrintsRunningAndAllReady(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	yes, no := true, false
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	waiting := func(reason string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}
	}
	ended := func(reason string, code int32) corev1.ContainerState {
		return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: reason, ExitCode: code}}
	}
	sidecars := []corev1.ContainerStatus{
		{Name: "side", Ready: true, Started: &yes, State: running},
		{Name: "side", Started: &yes, State: running},
		{Name: "side", Started: &no, State: running},
		{Name: "side", State: running},
		{Name: "side", Started: &no, State: waiting("CrashLoopBackOff")},
		{Name: "side", State: waiting("PodInitializing")},
		{Name: "side", Started: &no, State: ended("Error", 1)},
		{Name: "side", Started: &no, State: ended("Completed", 0)},
	}
	apps := []corev1.ContainerStatus{
		{Name: "app", Ready: true, State: running},
		{Name: "app", State: running},
		{Name: "app", State: waiting("CrashLoopBackOff")},
	}
	fine := 0
	for _, side := range sidecars {
		for _, app := range apps {
			for _, init := range []corev1.ConditionStatus{corev1.ConditionTrue, corev1.ConditionFalse} {
				p := &corev1.Pod{
					Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}, InitContainers: []corev1.Container{{Name: "side", RestartPolicy: &always}}},
					Status: corev1.PodStatus{
						Phase:                 corev1.PodRunning,
						Conditions:            []corev1.PodCondition{{Type: corev1.PodInitialized, Status: init}},
						InitContainerStatuses: []corev1.ContainerStatus{side},
						ContainerStatuses:     []corev1.ContainerStatus{app},
					},
				}
				status, ready, total, _ := podListView(p)
				want := status == "Running" && ready == total
				level, reason := podHealth(p)
				if (level == podHealthOK) != want {
					t.Errorf("sidecar %+v, app %+v, initialized %s: kubectl prints %s %d/%d, the card is %d %q", side.State, app.State, init, status, ready, total, level, reason)
				}
				if want {
					fine++
				}
			}
		}
	}
	if fine == 0 {
		t.Error("no state reads as fine")
	}
}

// A reason the warning list names is not an error even when no error reason
// comes before it; the levels the cases cover.
func TestPodHealth_WarnReasonsAreNotErrors(t *testing.T) {
	waiting := func(phase corev1.PodPhase, reason string) *corev1.Pod {
		return &corev1.Pod{
			Spec:   corev1.PodSpec{Containers: []corev1.Container{{Name: "c"}}},
			Status: corev1.PodStatus{Phase: phase, ContainerStatuses: []corev1.ContainerStatus{{Name: "c", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}}},
		}
	}
	cases := []struct {
		pod    *corev1.Pod
		level  uint8
		reason string
	}{
		{waiting(corev1.PodPending, "ContainerCreating"), podHealthWarn, "Pending"},
		{waiting(corev1.PodPending, "PodInitializing"), podHealthWarn, "Pending"},
		{waiting(corev1.PodRunning, "CrashLoopBackOff"), podHealthError, "CrashLoopBackOff"},
		{waiting(corev1.PodPending, "ImagePullBackOff"), podHealthError, "ImagePullBackOff"},
		{waiting(corev1.PodRunning, "ContainerStatusUnknown"), podHealthError, "ContainerStatusUnknown"},
	}
	for _, c := range cases {
		if l, r := podHealth(c.pod); l != c.level || r != c.reason {
			t.Errorf("%+v: got %d %q, want %d %q", c.pod.Status.ContainerStatuses[0].State.Waiting.Reason, l, r, c.level, c.reason)
		}
	}
	counts := map[string]int{}
	for _, c := range podHealthCases() {
		counts[c.Level]++
	}
	if counts["ok"] == 0 || counts["warn"] == 0 || counts["error"] == 0 {
		t.Errorf("the cases miss a level: %v", counts)
	}
}
