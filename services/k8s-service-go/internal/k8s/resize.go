package k8s

import (
	"context"
	"fmt"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ResizeRequest names one optimization row (a workload's container) and the
// request values to apply to its running pods through the resize subresource.
type ResizeRequest struct {
	Kind            string `json:"kind"`
	Name            string `json:"name"`
	Container       string `json:"container"`
	CPURequestM     *int64 `json:"cpu_request_m,omitempty"`
	MemRequestBytes *int64 `json:"mem_request_bytes,omitempty"`
}

// PodResizeResult is what happened to one pod: resized (the kubelet accepted
// it), pending (PodResizePending: Infeasible or Deferred), skipped (with the
// reason) or error (the API refused it).
type PodResizeResult struct {
	Pod    string `json:"pod"`
	Result string `json:"result"`
	Reason string `json:"reason,omitempty"`
}

type ResizeResult struct {
	Kind      string            `json:"kind"`
	Namespace string            `json:"namespace"`
	Name      string            `json:"name"`
	Container string            `json:"container"`
	Pods      []PodResizeResult `json:"pods"`
	Resized   int               `json:"resized"`
	Pending   int               `json:"pending"`
	Skipped   int               `json:"skipped"`
	Failed    int               `json:"failed"`
}

var resizeKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true, "Pod": true}

// ResizeKindAllowed is the set of workload kinds the optimization table groups pods by.
func ResizeKindAllowed(kind string) bool { return resizeKinds[kind] }

// resizeSettle is how long the kubelet gets to answer before the pod is read
// back once to tell a pending resize from an applied one.
const resizeSettle = 1500 * time.Millisecond

// ServerSupportsResize reports whether the API server is 1.35 or newer, where
// the pod resize subresource is GA.
func (s *Service) ServerSupportsResize(ctx context.Context) bool {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return false
	}
	v, err := cs.Discovery().ServerVersion()
	if err != nil {
		return false
	}
	return minorOf(v.GitVersion) >= 35
}

// ResizeWorkload applies req to the named container of every running pod the
// workload owns and reports the outcome per pod. The workload's template is
// not touched: the next rollout brings the template values back.
func (s *Service) ResizeWorkload(ctx context.Context, namespace string, req ResizeRequest) (*ResizeResult, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	podList, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	owner, err := s.workloadOwner(ctx, namespace)
	if err != nil {
		return nil, err
	}
	res := &ResizeResult{Kind: req.Kind, Namespace: namespace, Name: req.Name, Container: req.Container, Pods: []PodResizeResult{}}
	for i := range podList.Items {
		p := &podList.Items[i]
		if kind, name := owner(*p); kind != req.Kind || name != req.Name {
			continue
		}
		r := PodResizeResult{Pod: p.Name}
		idx := containerIndex(p.Spec.Containers, req.Container)
		switch {
		case p.Status.Phase != corev1.PodRunning || p.DeletionTimestamp != nil:
			r.Result, r.Reason = "skipped", "not-running"
		case idx < 0:
			r.Result, r.Reason = "skipped", "no-container"
		default:
			next, reason := resizedResources(p, idx, req)
			if reason != "" {
				r.Result, r.Reason = "skipped", reason
				break
			}
			pod := p.DeepCopy()
			pod.Spec.Containers[idx].Resources = next
			if _, err := cs.CoreV1().Pods(namespace).UpdateResize(ctx, pod.Name, pod, metav1.UpdateOptions{}); err != nil {
				r.Result, r.Reason = "error", err.Error()
			} else {
				r.Result = "resized"
			}
		}
		res.Pods = append(res.Pods, r)
	}
	if res.count("resized") > 0 {
		sleepCtx(ctx, resizeSettle)
		for i := range res.Pods {
			if res.Pods[i].Result != "resized" {
				continue
			}
			pod, err := cs.CoreV1().Pods(namespace).Get(ctx, res.Pods[i].Pod, metav1.GetOptions{})
			if err != nil {
				continue
			}
			if reason := resizePendingReason(pod); reason != "" {
				res.Pods[i].Result, res.Pods[i].Reason = "pending", reason
			}
		}
	}
	sort.Slice(res.Pods, func(i, j int) bool { return res.Pods[i].Pod < res.Pods[j].Pod })
	res.Resized, res.Pending, res.Skipped, res.Failed = res.count("resized"), res.count("pending"), res.count("skipped"), res.count("error")
	return res, nil
}

func (r *ResizeResult) count(result string) int {
	n := 0
	for _, p := range r.Pods {
		if p.Result == result {
			n++
		}
	}
	return n
}

func containerIndex(containers []corev1.Container, name string) int {
	for i, c := range containers {
		if c.Name == name {
			return i
		}
	}
	return -1
}

// resizedResources builds the container's new resources: requests take the
// requested values; a Guaranteed pod keeps limits equal to requests and a
// Burstable one raises a limit the new request would exceed, so the pod's QoS
// class does not change (the API refuses a resize that would). A resource
// whose resizePolicy restarts the container, a request that would turn a
// BestEffort pod Burstable and a no-op are skipped with the reason.
func resizedResources(p *corev1.Pod, idx int, req ResizeRequest) (corev1.ResourceRequirements, string) {
	c := p.Spec.Containers[idx]
	next := *c.Resources.DeepCopy()
	if next.Requests == nil {
		next.Requests = corev1.ResourceList{}
	}
	changed := false
	apply := func(name corev1.ResourceName, want resource.Quantity) string {
		if restartsOn(c, name) {
			return "restart-policy"
		}
		cur, has := next.Requests[name]
		if !has && p.Status.QOSClass == corev1.PodQOSBestEffort {
			return "qos"
		}
		if has && cur.Cmp(want) == 0 {
			return ""
		}
		next.Requests[name] = want
		if lim, ok := next.Limits[name]; ok && (p.Status.QOSClass == corev1.PodQOSGuaranteed || lim.Cmp(want) < 0) {
			next.Limits[name] = want
		}
		changed = true
		return ""
	}
	if req.CPURequestM != nil && *req.CPURequestM > 0 {
		if r := apply(corev1.ResourceCPU, *resource.NewMilliQuantity(*req.CPURequestM, resource.DecimalSI)); r != "" {
			return next, r
		}
	}
	if req.MemRequestBytes != nil && *req.MemRequestBytes > 0 {
		if r := apply(corev1.ResourceMemory, *resource.NewQuantity(*req.MemRequestBytes, resource.BinarySI)); r != "" {
			return next, r
		}
	}
	if !changed {
		return next, "unchanged"
	}
	return next, ""
}

func restartsOn(c corev1.Container, name corev1.ResourceName) bool {
	for _, p := range c.ResizePolicy {
		if p.ResourceName == name && p.RestartPolicy == corev1.RestartContainer {
			return true
		}
	}
	return false
}

func resizePendingReason(p *corev1.Pod) string {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodResizePending && c.Status == corev1.ConditionTrue {
			if c.Message != "" {
				return c.Reason + ": " + c.Message
			}
			return c.Reason
		}
	}
	return ""
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
