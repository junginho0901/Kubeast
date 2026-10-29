package k8s

import (
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
	created, deleted     int64 // unix seconds; deleted 0 = not being deleted
	ready, containers    uint16
	restarts             int32
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
	if ref := metav1.GetControllerOfNoCopy(p); ref != nil {
		r.ownerKind, r.ownerName = in.get(ref.Kind), ref.Name
	} else if len(p.OwnerReferences) > 0 {
		r.ownerKind, r.ownerName = in.get(p.OwnerReferences[0].Kind), p.OwnerReferences[0].Name
	}
	return r
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
