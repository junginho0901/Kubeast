package k8s

import (
	"slices"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The pod informer (informer_cache.go) keeps a podRow per pod instead of the
// Pod: what a row of the Pods list shows and the counts read, with the strings
// many pods share (namespace, node, phase, status, owner kind) stored once. A
// Pod struct costs some 1.4 KB even with every field empty, so 100 000 pods
// held as stripped Pods passed the k8s-service memory limit; a row with its
// store and index entries is held under podRowMaxBytes by TestPodRowMemory.
type podRow struct {
	name, namespace, rv  string
	node, phase, status  string
	podIP                string
	ownerKind, ownerName string
	healthReason         string
	// for the RuntimeClass, PriorityClass and ClusterRoleBinding drawers' pod lists
	runtimeClass, priorityClass, serviceAccount string
	// the workload the Hubble agent names (agentWorkload) and the GenerateName Calico names a pod set by, for the
	// network flows' lookup
	generateName, workloadKind, workloadName string
	// the labels as sorted "key\x1fvalue" pairs joined by "\x1e" — the same string for a set's pods, stored once — for
	// the AI's pod search, which matches label keys and values as it matches names
	labels string
	// the sums of the containers' limits, -1 when a container sets none (Monitoring Pods)
	cpuLimitMilli, memLimitBytes int64
	created, deleted             int64 // unix seconds; deleted 0 = not being deleted
	ready, containers            uint16
	restarts                     int32
	health                       uint8 // podHealthOK, podHealthWarn, podHealthError
}

// GetObjectMeta lets the store key and index the row (meta.Accessor).
func (r *podRow) GetObjectMeta() metav1.Object {
	return &metav1.ObjectMeta{Name: r.name, Namespace: r.namespace, ResourceVersion: r.rv}
}

// sameView reports whether two rows show the same thing; a new
// resourceVersion alone (a probe time, a condition's heartbeat) does not count.
func (r *podRow) sameView(o *podRow) bool {
	a, b := *r, *o
	a.rv, b.rv = "", ""
	return a == b
}

// interner returns one copy of each string it is given. It only grows, so it
// takes the strings few distinct values cover; it goes with its informer set,
// which stops after overviewIdleTimeout without a request.
type interner struct {
	mu sync.Mutex
	m  map[string]string
}

func newInterner() *interner { return &interner{m: map[string]string{}} }

func (in *interner) get(s string) string {
	if s == "" {
		return ""
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	if v, ok := in.m[s]; ok {
		return v
	}
	s = strings.Clone(s)
	in.m[s] = s
	return s
}

func toPodRow(p *corev1.Pod, in *interner) *podRow {
	r := &podRow{
		name:       p.Name,
		namespace:  in.get(p.Namespace),
		rv:         p.ResourceVersion,
		node:       in.get(p.Spec.NodeName),
		phase:      in.get(string(p.Status.Phase)),
		podIP:      p.Status.PodIP,
		created:    p.CreationTimestamp.Unix(),
		containers: uint16(len(p.Spec.Containers)),
	}
	if p.CreationTimestamp.IsZero() {
		r.created = 0
	}
	if p.DeletionTimestamp != nil {
		r.deleted = p.DeletionTimestamp.Unix()
	}
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Ready {
			r.ready++
		}
		r.restarts += cs.RestartCount
	}
	r.status = in.get(podListStatus(p, int(r.ready), int(r.containers)))
	if p.Spec.RuntimeClassName != nil {
		r.runtimeClass = in.get(*p.Spec.RuntimeClassName)
	}
	r.priorityClass = in.get(p.Spec.PriorityClassName)
	r.serviceAccount = in.get(p.Spec.ServiceAccountName)
	r.cpuLimitMilli, r.memLimitBytes = podLimits(p)
	r.generateName = in.get(p.GenerateName)
	r.labels = in.get(podLabelPairs(p.Labels))
	if w, ok := agentWorkload(p); ok {
		r.workloadKind, r.workloadName = in.get(w.Kind), in.get(w.Name)
	}
	h, reason := podHealth(p)
	r.health, r.healthReason = h, in.get(reason)
	if ref := metav1.GetControllerOfNoCopy(p); ref != nil {
		r.ownerKind, r.ownerName = in.get(ref.Kind), ref.Name
	} else if len(p.OwnerReferences) > 0 {
		r.ownerKind, r.ownerName = in.get(p.OwnerReferences[0].Kind), p.OwnerReferences[0].Name
	}
	return r
}

func podLabelPairs(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(labels))
	for k, v := range labels {
		pairs = append(pairs, k+"\x1f"+v)
	}
	slices.Sort(pairs)
	return strings.Join(pairs, "\x1e")
}

// podLimits sums the containers' cpu and memory limits; a container without one leaves the pod without a limit
// (-1), as the Monitoring page reads it (podUsage.ts podLimit).
func podLimits(p *corev1.Pod) (cpuMilli, memBytes int64) {
	if len(p.Spec.Containers) == 0 {
		return -1, -1
	}
	cpuMilli, memBytes = 0, 0
	for _, c := range p.Spec.Containers {
		if q, ok := c.Resources.Limits[corev1.ResourceCPU]; ok && cpuMilli >= 0 && q.MilliValue() > 0 {
			cpuMilli += q.MilliValue()
		} else {
			cpuMilli = -1
		}
		if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok && memBytes >= 0 && q.Value() > 0 {
			memBytes += q.Value()
		} else {
			memBytes = -1
		}
	}
	return cpuMilli, memBytes
}

// podListStatus is the Status column of the Pods list as the page used to work
// it out from formatPodDetail's fields (pickPodDisplayStatus): the pod's
// reason, else the first container status waiting before any terminated one
// (status_reason), else the first container in spec order that is waiting or
// terminated with a reason, else NotReady for a Running pod with containers
// not ready, else the phase.
func podListStatus(p *corev1.Pod, ready, total int) string {
	if p.Status.Reason != "" {
		return p.Status.Reason
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			return w.Reason
		}
		if t := cs.State.Terminated; t != nil && t.Reason != "" {
			break
		}
	}
	for _, c := range p.Spec.Containers {
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name != c.Name {
				continue
			}
			if w := cs.State.Waiting; w != nil && w.Reason != "" {
				return w.Reason
			}
			if t := cs.State.Terminated; t != nil && t.Reason != "" {
				return t.Reason
			}
			break
		}
	}
	phase := string(p.Status.Phase)
	if phase == "" {
		return "Unknown"
	}
	if p.Status.Phase == corev1.PodRunning && total > 0 && ready != total {
		return "NotReady"
	}
	return phase
}

// Cluster View's card colour (frontend pages/cluster-view/podHealth.tsx
// getPodHealth), kept on the row so the node map can colour every pod without
// the pods: TestPodHealthFixture writes the cases the page's own function is
// checked against.
const (
	podHealthOK uint8 = iota
	podHealthWarn
	podHealthError
)

var (
	podErrorReasons = []string{
		"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError",
		"RunContainerError", "ContainerCannotRun", "InvalidImageName", "ImageInspectError", "RegistryUnavailable",
		"ErrImageNeverPull", "OOMKilled", "Error",
	}
	podWarnReasons = []string{"ContainerCreating", "PodInitializing", "Pending", "NotReady"}
)

func pickReason(reasons, priority []string) string {
	for _, p := range priority {
		if slices.Contains(reasons, p) {
			return p
		}
	}
	if len(reasons) > 0 {
		return reasons[0]
	}
	return ""
}

func isCompletedReason(r string) bool { return r == "Completed" || r == "Succeeded" }

// podHealth is getPodHealth over the pod as formatPodDetail sends it: being
// deleted is a warning; an error reason (or phase Failed) is an error, where a
// reason the warning list names is never taken for one; Pending and Unknown
// warn; a Succeeded pod is fine; init containers not done, containers not
// ready or a waiting reason warn.
func podHealth(p *corev1.Pod) (uint8, string) {
	phase := listPhase(p)
	if p.DeletionTimestamp != nil {
		return podHealthWarn, "Terminating"
	}
	statusReason := ""
	if r := formattedReason(p); !isCompletedReason(r) {
		statusReason = r
	}
	byName := func(statuses []corev1.ContainerStatus, name string) *corev1.ContainerStatus {
		for i := range statuses {
			if statuses[i].Name == name {
				return &statuses[i]
			}
		}
		return nil
	}
	reasonsOf := func(containers []corev1.Container, statuses []corev1.ContainerStatus) (waiting, terminated []string) {
		for _, c := range containers {
			cs := byName(statuses, c.Name)
			if cs == nil {
				continue
			}
			if w := cs.State.Waiting; w != nil && strings.TrimSpace(w.Reason) != "" {
				waiting = append(waiting, w.Reason)
			}
			if t := cs.State.Terminated; t != nil && strings.TrimSpace(t.Reason) != "" && !isCompletedReason(t.Reason) {
				terminated = append(terminated, t.Reason)
			}
		}
		return waiting, terminated
	}
	waiting, terminated := reasonsOf(p.Spec.Containers, p.Status.ContainerStatuses)
	initWaiting, initTerminated := reasonsOf(p.Spec.InitContainers, p.Status.InitContainerStatuses)

	var candidates []string
	for _, list := range [][]string{{statusReason}, initWaiting, initTerminated, waiting, terminated} {
		for _, r := range list {
			if r != "" && !slices.Contains(podWarnReasons, r) {
				candidates = append(candidates, r)
			}
		}
	}
	if r := pickReason(candidates, podErrorReasons); r != "" || phase == string(corev1.PodFailed) {
		if r == "" {
			r = "Failed"
		}
		return podHealthError, r
	}

	ready, total := 0, len(p.Spec.Containers)
	for _, c := range p.Spec.Containers {
		if cs := byName(p.Status.ContainerStatuses, c.Name); cs != nil && cs.Ready {
			ready++
		}
	}
	initNotReady := false
	for _, c := range p.Spec.InitContainers {
		cs := byName(p.Status.InitContainerStatuses, c.Name)
		if cs == nil {
			continue
		}
		s := cs.State
		if s.Waiting != nil || s.Running != nil || (s.Terminated != nil && s.Terminated.ExitCode != 0) {
			initNotReady = true
			break
		}
	}
	switch {
	case phase == string(corev1.PodPending) || phase == string(corev1.PodUnknown):
		return podHealthWarn, phase
	case phase == string(corev1.PodSucceeded):
		return podHealthOK, "Succeeded"
	case initNotReady:
		if r := pickReason(initWaiting, podWarnReasons); r != "" {
			return podHealthWarn, r
		}
		return podHealthWarn, "PodInitializing"
	case total > 0 && ready < total:
		if r := pickReason(waiting, podWarnReasons); r != "" {
			return podHealthWarn, r
		}
		return podHealthWarn, "NotReady"
	}
	if r := pickReason(waiting, podWarnReasons); r != "" {
		return podHealthWarn, r
	}
	return podHealthOK, phase
}

// listPhase is the page's `pod.phase || pod.status || 'Unknown'` over
// formatPodDetail's fields.
func listPhase(p *corev1.Pod) string {
	if p.Status.Phase != "" {
		return string(p.Status.Phase)
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			return w.Reason
		}
		if t := cs.State.Terminated; t != nil && t.Reason != "" {
			return t.Reason
		}
	}
	return "Unknown"
}

// formattedReason is formatPodDetail's status_reason: the pod's reason, else
// the first container status waiting before any terminated one.
func formattedReason(p *corev1.Pod) string {
	if p.Status.Reason != "" {
		return p.Status.Reason
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			return w.Reason
		}
		if t := cs.State.Terminated; t != nil && t.Reason != "" {
			break
		}
	}
	return ""
}
