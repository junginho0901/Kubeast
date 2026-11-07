package k8s

import (
	"fmt"
	"math/rand"
	"strconv"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A Running pod whose containers are not all ready reads Running, as kubectl's STATUS (printPod, v1.37) says; the
// READY column carries readiness and the list draws it yellow. Until 10-31 the list said NotReady. Finding a pod by
// name still ranks it below a ready one, as before.
func TestPodListStatus_RunningNotReadyIsRunning(t *testing.T) {
	pod := func(ready bool) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
				Name: "app", Ready: ready, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}}},
		}
	}
	in := newInterner()
	notReady, ready := toPodRow(pod(false), in), toPodRow(pod(true), in)
	if notReady.status != "Running" {
		t.Fatalf("Running pod not ready: status %q, want Running (kubectl's STATUS)", notReady.status)
	}
	if got, _, _, _ := podListView(pod(false)); got != "Running" {
		t.Fatalf("podListView = %q, want Running", got)
	}
	if a, b := findScore(notReady), findScore(ready); a != 0 || b != 11 {
		t.Fatalf("find scores: not ready %d, ready %d — want 0 and 11, as when the status read NotReady", a, b)
	}
}

// kubectlPrintPod is printPod of Kubernetes v1.37.2 (pkg/printers/internalversion/printers.go, Apache-2.0), with the
// internal types as corev1 and the last restart's time and the row's other cells left out: what the list's STATUS,
// READY and RESTARTS are held to.
func kubectlPrintPod(pod *corev1.Pod) (status, readyCell string, restartCount int32) {
	restarts := 0
	restartableInitContainerRestarts := 0
	totalContainers := len(pod.Spec.Containers)
	readyContainers := 0

	podPhase := pod.Status.Phase
	reason := string(podPhase)
	if pod.Status.Reason != "" {
		reason = pod.Status.Reason
	}

	// If the Pod carries {type:PodScheduled, reason:SchedulingGated}, set reason to 'SchedulingGated'.
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodScheduled && condition.Reason == corev1.PodReasonSchedulingGated {
			reason = corev1.PodReasonSchedulingGated
		}
	}

	isRestartable := func(c *corev1.Container) bool {
		return c != nil && c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways
	}
	initContainers := make(map[string]*corev1.Container)
	for i := range pod.Spec.InitContainers {
		initContainers[pod.Spec.InitContainers[i].Name] = &pod.Spec.InitContainers[i]
		if isRestartable(&pod.Spec.InitContainers[i]) {
			totalContainers++
		}
	}

	initializing := false
	for i := range pod.Status.InitContainerStatuses {
		container := pod.Status.InitContainerStatuses[i]
		restarts += int(container.RestartCount)
		if isRestartable(initContainers[container.Name]) {
			restartableInitContainerRestarts += int(container.RestartCount)
		}
		switch {
		case container.State.Terminated != nil && container.State.Terminated.ExitCode == 0:
			continue
		case isRestartable(initContainers[container.Name]) &&
			container.Started != nil && *container.Started:
			if container.Ready {
				readyContainers++
			}
			continue
		case container.State.Terminated != nil:
			// initialization is failed
			if len(container.State.Terminated.Reason) == 0 {
				if container.State.Terminated.Signal != 0 {
					reason = fmt.Sprintf("Init:Signal:%d", container.State.Terminated.Signal)
				} else {
					reason = fmt.Sprintf("Init:ExitCode:%d", container.State.Terminated.ExitCode)
				}
			} else {
				reason = "Init:" + container.State.Terminated.Reason
			}
			initializing = true
		case container.State.Waiting != nil && len(container.State.Waiting.Reason) > 0 && container.State.Waiting.Reason != "PodInitializing":
			reason = "Init:" + container.State.Waiting.Reason
			initializing = true
		default:
			reason = fmt.Sprintf("Init:%d/%d", i, len(pod.Spec.InitContainers))
			initializing = true
		}
		break
	}

	isPodInitializedConditionTrue := func() bool {
		for _, condition := range pod.Status.Conditions {
			if condition.Type != corev1.PodInitialized {
				continue
			}
			return condition.Status == corev1.ConditionTrue
		}
		return false
	}
	hasPodReadyCondition := func() bool {
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
				return true
			}
		}
		return false
	}

	if !initializing || isPodInitializedConditionTrue() {
		restarts = restartableInitContainerRestarts
		hasRunning := false
		errorReason := ""
		for i := len(pod.Status.ContainerStatuses) - 1; i >= 0; i-- {
			container := pod.Status.ContainerStatuses[i]

			restarts += int(container.RestartCount)
			switch {
			case container.State.Waiting != nil && container.State.Waiting.Reason != "":
				reason = container.State.Waiting.Reason
			case container.State.Terminated != nil:
				if len(container.State.Terminated.Reason) > 0 {
					reason = container.State.Terminated.Reason
				} else if container.State.Terminated.Signal != 0 {
					reason = fmt.Sprintf("Signal:%d", container.State.Terminated.Signal)
				} else {
					reason = fmt.Sprintf("ExitCode:%d", container.State.Terminated.ExitCode)
				}
				if container.State.Terminated.ExitCode != 0 {
					errorReason = reason
				}
			case container.Ready && container.State.Running != nil:
				hasRunning = true
				readyContainers++
			}
		}

		// change pod status back to "Running" if there is at least one container still reporting as "Running" status
		if reason == "Completed" {
			if hasRunning && hasPodReadyCondition() {
				reason = "Running"
			} else if errorReason != "" {
				reason = errorReason
			} else if hasRunning {
				reason = "NotReady"
			}
		}
	}

	if pod.DeletionTimestamp != nil && pod.Status.Reason == "NodeLost" {
		reason = "Unknown"
	} else if pod.DeletionTimestamp != nil && podPhase != corev1.PodFailed && podPhase != corev1.PodSucceeded {
		reason = "Terminating"
	}

	return reason, strconv.Itoa(readyContainers) + "/" + strconv.Itoa(totalContainers), int32(restarts)
}

// kubectlStatus is kubectl's STATUS, except that a pod with no phase at all reads Unknown: the API server sets a phase
// when a pod is made, so only a hand-made object has none, and an empty cell would say nothing.
func kubectlStatus(p *corev1.Pod) string {
	status, _, _ := kubectlPrintPod(p)
	if status == "" {
		return "Unknown"
	}
	return status
}

// randomPrintPod draws a pod from every state printPod tells apart, also ones only a stale or partial status has.
func randomPrintPod(rng *rand.Rand, i int) *corev1.Pod {
	phases := []corev1.PodPhase{corev1.PodRunning, corev1.PodRunning, corev1.PodRunning, corev1.PodPending, corev1.PodSucceeded, corev1.PodFailed, corev1.PodUnknown, ""}
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ns", Name: fmt.Sprintf("p-%05d", i), CreationTimestamp: metav1.NewTime(time.Unix(1_700_000_000, 0))},
		Status:     corev1.PodStatus{Phase: phases[rng.Intn(len(phases))]},
	}
	if rng.Intn(4) == 0 {
		p.DeletionTimestamp = &metav1.Time{Time: time.Unix(1_700_000_100, 0)}
	}
	if rng.Intn(5) == 0 {
		p.Status.Reason = []string{"Evicted", "NodeLost", "Completed", "UnexpectedAdmissionError"}[rng.Intn(4)]
	}
	condition := func(t corev1.PodConditionType) {
		switch rng.Intn(3) {
		case 0:
			p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{Type: t, Status: corev1.ConditionTrue})
		case 1:
			p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{Type: t, Status: corev1.ConditionFalse})
		}
	}
	condition(corev1.PodInitialized)
	condition(corev1.PodReady)
	if rng.Intn(10) == 0 {
		p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonSchedulingGated})
	}
	state := func() corev1.ContainerState {
		switch rng.Intn(9) {
		case 0:
			return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: []string{"CrashLoopBackOff", "ImagePullBackOff", "ContainerCreating", "PodInitializing", "ErrImagePull"}[rng.Intn(5)]}}
		case 1:
			return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{}}
		case 2:
			return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}
		case 3:
			return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: []string{"Error", "OOMKilled", "ContainerStatusUnknown"}[rng.Intn(3)], ExitCode: 137}}
		case 4:
			return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: int32(rng.Intn(3)), Signal: int32(rng.Intn(2) * 9)}}
		case 5:
			return corev1.ContainerState{} // no state yet
		default:
			return corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
		}
	}
	for c := 0; c < rng.Intn(3); c++ {
		name := fmt.Sprintf("init%d", c)
		ic := corev1.Container{Name: name}
		if rng.Intn(3) == 0 {
			always := corev1.ContainerRestartPolicyAlways
			ic.RestartPolicy = &always
		}
		p.Spec.InitContainers = append(p.Spec.InitContainers, ic)
		if rng.Intn(6) > 0 {
			cs := corev1.ContainerStatus{Name: name, Ready: rng.Intn(2) == 0, RestartCount: int32(rng.Intn(3)), State: state()}
			if rng.Intn(2) == 0 {
				started := rng.Intn(2) == 0
				cs.Started = &started
			}
			p.Status.InitContainerStatuses = append(p.Status.InitContainerStatuses, cs)
		}
	}
	for c := 0; c < 1+rng.Intn(3); c++ {
		name := fmt.Sprintf("c%d", c)
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: name})
		if rng.Intn(6) == 0 {
			continue
		}
		cs := corev1.ContainerStatus{Name: name, Ready: rng.Intn(3) > 0, RestartCount: int32(rng.Intn(3)), State: state()}
		if rng.Intn(4) == 0 {
			p.Status.ContainerStatuses = append([]corev1.ContainerStatus{cs}, p.Status.ContainerStatuses...)
		} else {
			p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, cs)
		}
	}
	return p
}

// The list's Status, READY and RESTARTS, the row's and the detail's, are what kubectl prints, for every state the
// generator draws.
func TestPodListView_AsKubectlPrintsIt(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	in := newInterner()
	wrong := 0
	for i := 0; i < 20000 && wrong < 5; i++ {
		p := randomPrintPod(rng, i)
		_, ready, restarts := kubectlPrintPod(p)
		status := kubectlStatus(p)
		r := toPodRow(p, in)
		it := r.item()
		if it.Status != status || it.Ready != ready || it.RestartCount != restarts {
			t.Errorf("pod %d row: %s %s %d, kubectl %s %s %d (%+v, deleted %v)", i, it.Status, it.Ready, it.RestartCount, status, ready, restarts, p.Status, p.DeletionTimestamp != nil)
			wrong++
		}
		d := formatPodDetail(p)
		if d["status"] != status || d["ready"] != ready || d["restart_count"] != restarts {
			t.Errorf("pod %d detail: %v %v %v, kubectl %s %s %d", i, d["status"], d["ready"], d["restart_count"], status, ready, restarts)
			wrong++
		}
	}
}

// What kubectl prints for the states the list got wrong, written out so a reader sees them and so kubectlPrintPod is
// held too.
func TestPodListView_StatesKubectlNames(t *testing.T) {
	now := metav1.Now()
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	waiting := func(r string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: r}}
	}
	done := func(code int32, reason string, signal int32) corev1.ContainerState {
		return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: code, Reason: reason, Signal: signal}}
	}
	ready := func(s corev1.ContainerState) corev1.ContainerStatus {
		return corev1.ContainerStatus{Ready: true, State: s}
	}
	notReady := func(s corev1.ContainerState) corev1.ContainerStatus { return corev1.ContainerStatus{State: s} }
	pod := func(phase corev1.PodPhase, mod func(p *corev1.Pod), cs ...corev1.ContainerStatus) *corev1.Pod {
		p := &corev1.Pod{}
		p.Name, p.Namespace = "p", "ns"
		p.Status.Phase = phase
		for i := range cs {
			cs[i].Name = fmt.Sprintf("c%d", i)
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: cs[i].Name})
		}
		p.Status.ContainerStatuses = cs
		if mod != nil {
			mod(p)
		}
		return p
	}
	deleted := func(p *corev1.Pod) { p.DeletionTimestamp = &now }
	reason := func(r string) func(p *corev1.Pod) { return func(p *corev1.Pod) { p.Status.Reason = r } }
	failedInit := func(p *corev1.Pod) {
		p.Spec.InitContainers = []corev1.Container{{Name: "migrate"}}
		p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "migrate", RestartCount: 3, State: done(1, "Error", 0)}}
	}
	cases := []struct {
		name          string
		p             *corev1.Pod
		status, ready string
	}{
		{"being deleted while running", pod(corev1.PodRunning, deleted, ready(running)), "Terminating", "1/1"},
		{"being deleted while not ready", pod(corev1.PodRunning, deleted, notReady(running)), "Terminating", "0/1"},
		{"being deleted while pending", pod(corev1.PodPending, deleted, notReady(waiting("ContainerCreating"))), "Terminating", "0/1"},
		{"being deleted while crash looping", pod(corev1.PodRunning, deleted, notReady(waiting("CrashLoopBackOff"))), "Terminating", "0/1"},
		{"being deleted while initializing", pod(corev1.PodPending, func(p *corev1.Pod) { deleted(p); failedInit(p) }, notReady(waiting("PodInitializing"))), "Terminating", "0/1"},
		{"being deleted on a node that stopped answering", pod(corev1.PodRunning, func(p *corev1.Pod) { deleted(p); p.Status.Reason = "NodeLost" }, ready(running)), "Unknown", "1/1"},
		{"being deleted after it succeeded", pod(corev1.PodSucceeded, deleted, notReady(done(0, "Completed", 0))), "Completed", "0/1"},
		{"being deleted after it failed", pod(corev1.PodFailed, deleted, notReady(done(1, "Error", 0))), "Error", "0/1"},
		{"held by scheduling gates", pod(corev1.PodPending, func(p *corev1.Pod) {
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonSchedulingGated}}
		}), "SchedulingGated", "0/0"},
		{"the pod's reason with no container saying more", pod(corev1.PodFailed, reason("Evicted")), "Evicted", "0/0"},
		{"a container's reason over the pod's", pod(corev1.PodFailed, reason("Evicted"), notReady(done(137, "ContainerStatusUnknown", 0))), "ContainerStatusUnknown", "0/1"},
		{"ended with an exit code and no reason", pod(corev1.PodFailed, nil, notReady(done(2, "", 0))), "ExitCode:2", "0/1"},
		{"ended on a signal and no reason", pod(corev1.PodFailed, nil, notReady(done(137, "", 9))), "Signal:9", "0/1"},
		{"the first container that names something", pod(corev1.PodRunning, nil, notReady(waiting("ImagePullBackOff")), notReady(done(1, "Error", 0))), "ImagePullBackOff", "0/2"},
		{"one done and one running, the pod ready", pod(corev1.PodRunning, func(p *corev1.Pod) {
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
		}, notReady(done(0, "Completed", 0)), ready(running)), "Running", "1/2"},
		{"one done and one running, the pod not ready", pod(corev1.PodRunning, nil, notReady(done(0, "Completed", 0)), ready(running)), "NotReady", "1/2"},
		{"one done and one failed", pod(corev1.PodRunning, nil, notReady(done(0, "Completed", 0)), notReady(done(1, "Error", 0))), "Error", "0/2"},
		{"an init failure the Initialized condition does not clear", pod(corev1.PodRunning, func(p *corev1.Pod) {
			failedInit(p)
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodInitialized, Status: corev1.ConditionTrue}}
		}, ready(running)), "Init:Error", "1/1"},
		{"ready flag on a container that is not running", pod(corev1.PodRunning, nil, ready(done(0, "Completed", 0))), "Completed", "0/1"},
		{"a container counted only once initializing is over", pod(corev1.PodPending, failedInit, ready(running)), "Init:Error", "0/1"},
	}
	for _, c := range cases {
		if status, ready, _ := kubectlPrintPod(c.p); status != c.status || ready != c.ready {
			t.Errorf("%s: kubectlPrintPod %s %s, the case says %s %s", c.name, status, ready, c.status, c.ready)
		}
		status, ready, total, _ := podListView(c.p)
		if got := strconv.Itoa(ready) + "/" + strconv.Itoa(total); status != c.status || got != c.ready {
			t.Errorf("%s: podListView %s %s, kubectl %s %s", c.name, status, got, c.status, c.ready)
		}
	}
}
