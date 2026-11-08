package k8s

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	resourcehelper "k8s.io/component-helpers/resource"
)

// allocatedTotals adds up what kubectl describe node prints under "Allocated resources" (kubectl
// getPodsTotalRequestsAndLimits): each pod's requests and limits as Kubernetes counts them.
type allocatedTotals struct{ requests, limits corev1.ResourceList }

// podAllocation is what kubectl describe node counts of one pod: its requests and limits, nothing once it has ended.
type podAllocation struct {
	requests, limits corev1.ResourceList
	ended            bool
}

// allocationOf counts p as Kubernetes does (init containers at their peak, sidecars added, pod overhead and pod-level
// resources); kubectl lists the pods not Succeeded or Failed.
func allocationOf(p *corev1.Pod) podAllocation {
	return podAllocation{
		requests: resourcehelper.PodRequests(p, resourcehelper.PodResourcesOptions{}),
		limits:   resourcehelper.PodLimits(p, resourcehelper.PodResourcesOptions{}),
		ended:    p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed,
	}
}

func (t *allocatedTotals) add(a podAllocation) {
	if a.ended {
		return
	}
	sum := func(total, pod corev1.ResourceList) {
		for name, q := range pod {
			if have, ok := total[name]; ok {
				have.Add(q)
				total[name] = have
			} else {
				total[name] = q.DeepCopy()
			}
		}
	}
	sum(t.requests, a.requests)
	sum(t.limits, a.limits)
}

// nodeAllocatedTotals adds up the pods kubectl sums from the node's read its pod table and Cluster View share
// (podsOnNodeOf): one read as kubeast:cache for everyone opening the node, kept to the namespaces the caller's identity
// may list pods in, a namespace that check refuses listed as the caller. A grant limited to namespaces is told nothing
// of the other pods on the node.
func (s *Service) nodeAllocatedTotals(ctx context.Context, node string) (*allocatedTotals, error) {
	pods, err := s.podsOnNodeOf(ctx, node, "")
	if err != nil {
		return nil, err
	}
	t := &allocatedTotals{requests: corev1.ResourceList{}, limits: corev1.ResourceList{}}
	for _, a := range pods.alloc {
		t.add(a)
	}
	return t, nil
}

// allocatedPercent is kubectl's: a share of the node's value cut to a whole number, 0 on a node that reports none.
func allocatedPercent(q, of resource.Quantity, value func(*resource.Quantity) int64) int64 {
	total := value(&of)
	if total == 0 {
		return 0
	}
	return int64(float64(value(&q)) / float64(total) * 100)
}

// allocatedRows prints the totals as kubectl describeNodeResource does: cpu, memory and ephemeral storage, the node's
// hugepages, then its other resources, those without a percent.
func allocatedRows(node *corev1.Node, t *allocatedTotals) []map[string]string {
	allocatable := node.Status.Capacity
	if len(node.Status.Allocatable) > 0 {
		allocatable = node.Status.Allocatable
	}
	milli := func(q *resource.Quantity) int64 { return q.MilliValue() }
	plain := func(q *resource.Quantity) int64 { return q.Value() }
	withPercent := func(name corev1.ResourceName, value func(*resource.Quantity) int64) map[string]string {
		req, lim, of := t.requests[name], t.limits[name], allocatable[name]
		return map[string]string{
			"resource": string(name),
			"requests": fmt.Sprintf("%s (%d%%)", req.String(), allocatedPercent(req, of, value)),
			"limits":   fmt.Sprintf("%s (%d%%)", lim.String(), allocatedPercent(lim, of, value)),
		}
	}
	rows := []map[string]string{
		withPercent(corev1.ResourceCPU, milli),
		withPercent(corev1.ResourceMemory, plain),
		withPercent(corev1.ResourceEphemeralStorage, plain),
	}
	var hugepages, others []string
	for name := range allocatable {
		switch {
		case strings.HasPrefix(string(name), corev1.ResourceHugePagesPrefix):
			hugepages = append(hugepages, string(name))
		case name != corev1.ResourceCPU && name != corev1.ResourceMemory && name != corev1.ResourceEphemeralStorage && name != corev1.ResourcePods:
			others = append(others, string(name))
		}
	}
	sort.Strings(hugepages)
	sort.Strings(others)
	for _, name := range hugepages {
		rows = append(rows, withPercent(corev1.ResourceName(name), plain))
	}
	for _, name := range others {
		req, lim := t.requests[corev1.ResourceName(name)], t.limits[corev1.ResourceName(name)]
		rows = append(rows, map[string]string{"resource": name, "requests": req.String(), "limits": lim.String()})
	}
	return rows
}

// setAllocated gives the Node drawer its Allocated Resources: the rows, with the namespaces they cover for a grant
// limited to them, or why the pods could not be read and no rows (kubectl prints "not authorized" there).
func setAllocated(result map[string]interface{}, node *corev1.Node, t *allocatedTotals, err error, scope []string) {
	if err != nil {
		reason := err.Error()
		if reason == "" {
			reason = "pods could not be listed: " + string(apierrors.ReasonForError(err))
		}
		result["allocated_error"] = reason
		return
	}
	result["allocated_resources"] = allocatedRows(node, t)
	if len(scope) > 0 {
		result["allocated_scope"] = scope
	}
}
