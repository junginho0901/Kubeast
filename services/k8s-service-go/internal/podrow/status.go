package podrow

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
)

// StatusTerminating is the Status of a pod being deleted that has not finished.
const StatusTerminating = "Terminating"

// ListView is a pod's Status, READY and RESTARTS as kubectl prints them; the Pods list, the pod detail, the drawers' pod
// tables, the GPU pods and the Resource Graph's pod boxes all show these.
func ListView(p *corev1.Pod) (status string, ready, total int, restarts int32) {
	iv := initState(p)
	ready, total, restarts = counts(p, iv)
	return listStatus(p, iv), ready, total, restarts
}

// listStatus is kubectl's STATUS (Kubernetes v1.37 printers.go printPod): the phase, the pod's reason over it, then
// SchedulingGated, then what the init containers say. Unless initializing holds the pod, the first container status that
// is waiting with a reason or has ended goes over that; "Completed" with another container running reads Running or
// NotReady by the pod's Ready condition, and one that failed names the failure. Readiness alone does not change it: a
// Running pod not ready stays Running, and the list draws that yellow. Last, a pod being deleted on a node that stopped
// answering is Unknown, and another that has not finished Terminating. A pod with no phase, which only a hand-made object
// has, reads Unknown.
func listStatus(p *corev1.Pod, iv initView) string {
	reason := string(p.Status.Phase)
	if p.Status.Reason != "" {
		reason = p.Status.Reason
	}
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodScheduled && c.Reason == corev1.PodReasonSchedulingGated {
			reason = corev1.PodReasonSchedulingGated
		}
	}
	if iv.reason != "" {
		reason = iv.reason
	}
	if iv.status == "" {
		reason = containersStatus(p, reason)
	}
	if p.DeletionTimestamp != nil {
		if p.Status.Reason == "NodeLost" {
			return "Unknown"
		}
		if p.Status.Phase != corev1.PodSucceeded && p.Status.Phase != corev1.PodFailed {
			return StatusTerminating
		}
	}
	if reason == "" {
		return "Unknown"
	}
	return reason
}

// containersStatus is what the containers' statuses make of reason: kubectl walks them from the last, so the first that
// names something wins.
func containersStatus(p *corev1.Pod, reason string) string {
	hasRunning, errorReason := false, ""
	for i := len(p.Status.ContainerStatuses) - 1; i >= 0; i-- {
		cs := &p.Status.ContainerStatuses[i]
		switch w, t := cs.State.Waiting, cs.State.Terminated; {
		case w != nil && w.Reason != "":
			reason = w.Reason
		case t != nil:
			switch {
			case t.Reason != "":
				reason = t.Reason
			case t.Signal != 0:
				reason = fmt.Sprintf("Signal:%d", t.Signal)
			default:
				reason = fmt.Sprintf("ExitCode:%d", t.ExitCode)
			}
			if t.ExitCode != 0 {
				errorReason = reason
			}
		case cs.Ready && cs.State.Running != nil:
			hasRunning = true
		}
	}
	if reason != "Completed" {
		return reason
	}
	switch {
	case hasRunning && readyCondition(p):
		return "Running"
	case errorReason != "":
		return errorReason
	case hasRunning:
		return "NotReady"
	}
	return reason
}

func readyCondition(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

// initView is a pod's init containers as kubectl reads them (Kubernetes v1.37 printers.go printPod): while an init
// container has not finished and the Initialized condition is not true, the pod's Status is "Init:<reason>",
// "Init:Signal:<n>", "Init:ExitCode:<n>" or "Init:<done>/<all>" and its restarts are the init containers'; once
// initialized, restartable init containers (sidecars) count with the containers.
type initView struct {
	status          string // "" when the pod is not initializing
	reason          string // the same word whatever the condition says: it stays the Status unless a container names another
	restarts        int32  // the init containers' restarts, up to the one it waits on
	sidecarRestarts int32  // the restartable ones' among them
	sidecars        int    // restartable init containers in the spec, counted as containers
	sidecarsReady   int    // the started and ready ones before the one it waits on
}

func initState(p *corev1.Pod) initView {
	var v initView
	spec := make(map[string]*corev1.Container, len(p.Spec.InitContainers))
	for i := range p.Spec.InitContainers {
		c := &p.Spec.InitContainers[i]
		spec[c.Name] = c
		if restartableInit(c) {
			v.sidecars++
		}
	}
	reason := ""
	for i, cs := range p.Status.InitContainerStatuses {
		v.restarts += cs.RestartCount
		sidecar := restartableInit(spec[cs.Name])
		if sidecar {
			v.sidecarRestarts += cs.RestartCount
		}
		switch t, w := cs.State.Terminated, cs.State.Waiting; {
		case t != nil && t.ExitCode == 0:
			continue
		case sidecar && cs.Started != nil && *cs.Started:
			if cs.Ready {
				v.sidecarsReady++
			}
			continue
		case t != nil && t.Reason != "":
			reason = "Init:" + t.Reason
		case t != nil && t.Signal != 0:
			reason = fmt.Sprintf("Init:Signal:%d", t.Signal)
		case t != nil:
			reason = fmt.Sprintf("Init:ExitCode:%d", t.ExitCode)
		case w != nil && w.Reason != "" && w.Reason != "PodInitializing":
			reason = "Init:" + w.Reason
		default:
			reason = fmt.Sprintf("Init:%d/%d", i, len(p.Spec.InitContainers))
		}
		break
	}
	v.reason = reason
	if reason != "" && !initialized(p) {
		v.status = reason
	}
	return v
}

func restartableInit(c *corev1.Container) bool {
	return c != nil && c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways
}

func initialized(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodInitialized {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// counts are the READY and RESTARTS columns as kubectl prints them: the containers and the sidecars, and while
// initializing the init containers' restarts. A container is ready when it says so and is running, and none is counted
// while initializing holds the pod.
func counts(p *corev1.Pod, iv initView) (ready, total int, restarts int32) {
	total = len(p.Spec.Containers) + iv.sidecars
	ready = iv.sidecarsReady
	for _, cs := range p.Status.ContainerStatuses {
		if iv.status == "" && cs.Ready && cs.State.Running != nil {
			ready++
		}
		restarts += cs.RestartCount
	}
	if iv.status != "" {
		return ready, total, iv.restarts
	}
	return ready, total, restarts + iv.sidecarRestarts
}
