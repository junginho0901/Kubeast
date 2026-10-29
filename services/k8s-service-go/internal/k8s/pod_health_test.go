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

type podHealthCase struct {
	Pod    map[string]interface{} `json:"pod"`
	Level  string                 `json:"level"`
	Reason string                 `json:"reason"`
}

func podHealthCases() []podHealthCase {
	rng := rand.New(rand.NewSource(7))
	levels := []string{"ok", "warn", "error"}
	keep := []string{"phase", "status", "status_reason", "deletion_timestamp"}
	var out []podHealthCase
	for i := 0; i < 600; i++ {
		p := randomHealthPod(rng, i)
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
				for _, f := range []string{"ready", "state"} {
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
