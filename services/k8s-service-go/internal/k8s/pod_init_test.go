package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

// The pod row and the pod detail read the init containers as kubectl v1.37 prints a pod (printers.go printPod):
// the expected STATUS, READY and RESTARTS below are what that function gives for each pod.
func TestPodInit_AsKubectlPrintsIt(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	started := true
	waiting := func(r string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: r}}
	}
	done := func(code int32, reason string, signal int32) corev1.ContainerState {
		return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: code, Reason: reason, Signal: signal}}
	}
	running := corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	pod := func(phase corev1.PodPhase, inits []corev1.ContainerStatus, initSpec []corev1.Container, main corev1.ContainerStatus, initialized bool) *corev1.Pod {
		p := &corev1.Pod{}
		p.Name, p.Namespace = "p", "ns"
		p.Spec.InitContainers = initSpec
		if p.Spec.InitContainers == nil {
			for _, cs := range inits {
				p.Spec.InitContainers = append(p.Spec.InitContainers, corev1.Container{Name: cs.Name})
			}
		}
		p.Spec.Containers = []corev1.Container{{Name: "app"}}
		main.Name = "app"
		p.Status = corev1.PodStatus{Phase: phase, InitContainerStatuses: inits, ContainerStatuses: []corev1.ContainerStatus{main}}
		if initialized {
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodInitialized, Status: corev1.ConditionTrue}}
		}
		return p
	}
	cases := []struct {
		name            string
		p               *corev1.Pod
		status, ready   string
		restarts        int32
		detailStatusSet bool
	}{
		{"init failed", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "migrate", RestartCount: 3, State: done(1, "Error", 0)}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:Error", "0/1", 3, true},
		{"init crash looping", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "migrate", RestartCount: 5, State: waiting("CrashLoopBackOff")}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:CrashLoopBackOff", "0/1", 5, true},
		{"second of two running", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "a", State: done(0, "Completed", 0)}, {Name: "b", State: running}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:1/2", "0/1", 0, true},
		{"waiting to start", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "a", State: waiting("PodInitializing")}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:0/1", "0/1", 0, true},
		{"killed without a reason", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "a", State: done(137, "", 9)}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:Signal:9", "0/1", 0, true},
		{"exit code without a reason", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "a", State: done(2, "", 0)}}, nil,
			corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:ExitCode:2", "0/1", 0, true},
		// the Initialized condition wins over a stale init status: the containers' columns as before
		{"initialized", pod(corev1.PodRunning, []corev1.ContainerStatus{{Name: "a", RestartCount: 4, State: done(1, "Error", 0)}}, nil,
			corev1.ContainerStatus{Ready: true, RestartCount: 1, State: running}, true), "Running", "1/1", 1, false},
		// a started sidecar (restartable init container) counts as a container, its restarts too
		{"sidecar", pod(corev1.PodRunning, []corev1.ContainerStatus{{Name: "proxy", Ready: true, Started: &started, RestartCount: 2, State: running}},
			[]corev1.Container{{Name: "proxy", RestartPolicy: &always}}, corev1.ContainerStatus{Ready: true, RestartCount: 1, State: running}, true), "Running", "2/2", 3, false},
		{"sidecar not started", pod(corev1.PodPending, []corev1.ContainerStatus{{Name: "proxy", State: waiting("PodInitializing")}},
			[]corev1.Container{{Name: "proxy", RestartPolicy: &always}}, corev1.ContainerStatus{State: waiting("PodInitializing")}, false), "Init:0/1", "0/2", 0, true},
	}
	for _, c := range cases {
		r := toPodRow(c.p, newInterner())
		if r.status != c.status || r.item().Ready != c.ready || r.restarts != c.restarts {
			t.Errorf("%s: row %s %s %d, kubectl %s %s %d", c.name, r.status, r.item().Ready, r.restarts, c.status, c.ready, c.restarts)
		}
		d := formatPodDetail(c.p)
		if d["ready"] != c.ready || d["restart_count"] != c.restarts || (c.detailStatusSet && d["status"] != c.status) {
			t.Errorf("%s: detail %v %v %v, kubectl %s %s %d", c.name, d["status"], d["ready"], d["restart_count"], c.status, c.ready, c.restarts)
		}
	}
}
