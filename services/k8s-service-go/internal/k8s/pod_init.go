package k8s

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
)

// podInitView is a pod's init containers as kubectl reads them (Kubernetes v1.37 printers.go printPod): while an
// init container has not finished and the Initialized condition is not true, the pod's Status is
// "Init:<reason>", "Init:Signal:<n>", "Init:ExitCode:<n>" or "Init:<done>/<all>" and its restarts are the init
// containers'; once initialized, restartable init containers (sidecars) count with the containers.
type podInitView struct {
	status          string // "" when the pod is not initializing
	restarts        int32  // the init containers' restarts, up to the one it waits on
	sidecarRestarts int32  // the restartable ones' among them
	sidecars        int    // restartable init containers in the spec, counted as containers
	sidecarsReady   int    // the started and ready ones before the one it waits on
}

func podInitState(p *corev1.Pod) podInitView {
	var v podInitView
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
	if reason != "" && !podInitialized(p) {
		v.status = reason
	}
	return v
}

func restartableInit(c *corev1.Container) bool {
	return c != nil && c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways
}

func podInitialized(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodInitialized {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// podCounts are the READY and RESTARTS columns as kubectl prints them: the containers and the sidecars, and while
// initializing the init containers' restarts.
func podCounts(p *corev1.Pod, iv podInitView) (ready, total int, restarts int32) {
	total = len(p.Spec.Containers) + iv.sidecars
	ready = iv.sidecarsReady
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
		restarts += cs.RestartCount
	}
	if iv.status != "" {
		return ready, total, iv.restarts
	}
	return ready, total, restarts + iv.sidecarRestarts
}
