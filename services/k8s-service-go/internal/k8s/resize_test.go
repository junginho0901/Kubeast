package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func i64(v int64) *int64 { return &v }

func resizePod(qos corev1.PodQOSClass, c corev1.Container) *corev1.Pod {
	return &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{c}}, Status: corev1.PodStatus{Phase: corev1.PodRunning, QOSClass: qos}}
}

func reqList(cpu, mem string) corev1.ResourceList {
	out := corev1.ResourceList{}
	if cpu != "" {
		out[corev1.ResourceCPU] = resource.MustParse(cpu)
	}
	if mem != "" {
		out[corev1.ResourceMemory] = resource.MustParse(mem)
	}
	return out
}

func TestResizedResources(t *testing.T) {
	req := ResizeRequest{Kind: "Deployment", Name: "web", Container: "app", CPURequestM: i64(150), MemRequestBytes: i64(96 << 20)}

	// Burstable: requests move, a limit below the new request is raised, the other limit stays.
	burst := resizePod(corev1.PodQOSBurstable, corev1.Container{Name: "app", Resources: corev1.ResourceRequirements{Requests: reqList("50m", "32Mi"), Limits: reqList("100m", "256Mi")}})
	got, reason := resizedResources(burst, 0, req)
	if reason != "" {
		t.Fatalf("burstable skipped: %s", reason)
	}
	if got.Requests.Cpu().MilliValue() != 150 || got.Requests.Memory().Value() != 96<<20 {
		t.Fatalf("requests = %v", got.Requests)
	}
	if got.Limits.Cpu().MilliValue() != 150 || got.Limits.Memory().Value() != 256<<20 {
		t.Fatalf("limits = %v", got.Limits)
	}

	// Guaranteed: limits follow requests so the class is kept.
	guar := resizePod(corev1.PodQOSGuaranteed, corev1.Container{Name: "app", Resources: corev1.ResourceRequirements{Requests: reqList("500m", "512Mi"), Limits: reqList("500m", "512Mi")}})
	got, reason = resizedResources(guar, 0, req)
	if reason != "" || got.Limits.Cpu().MilliValue() != 150 || got.Limits.Memory().Value() != 96<<20 {
		t.Fatalf("guaranteed: reason %q limits %v", reason, got.Limits)
	}

	// BestEffort would turn Burstable: skipped.
	if _, reason = resizedResources(resizePod(corev1.PodQOSBestEffort, corev1.Container{Name: "app"}), 0, req); reason != "qos" {
		t.Fatalf("besteffort reason = %q", reason)
	}

	// A resource whose policy restarts the container is skipped.
	restart := resizePod(corev1.PodQOSBurstable, corev1.Container{Name: "app", Resources: corev1.ResourceRequirements{Requests: reqList("50m", "32Mi")},
		ResizePolicy: []corev1.ContainerResizePolicy{{ResourceName: corev1.ResourceMemory, RestartPolicy: corev1.RestartContainer}}})
	if _, reason = resizedResources(restart, 0, req); reason != "restart-policy" {
		t.Fatalf("restart reason = %q", reason)
	}
	cpuOnly := ResizeRequest{CPURequestM: i64(150)}
	if _, reason = resizedResources(restart, 0, cpuOnly); reason != "" {
		t.Fatalf("cpu alone on a memory-restart container: %q", reason)
	}

	// Same values: nothing to do.
	same := resizePod(corev1.PodQOSBurstable, corev1.Container{Name: "app", Resources: corev1.ResourceRequirements{Requests: reqList("150m", "96Mi")}})
	if _, reason = resizedResources(same, 0, req); reason != "unchanged" {
		t.Fatalf("unchanged reason = %q", reason)
	}
}

func TestResizePendingReasonAndKinds(t *testing.T) {
	p := &corev1.Pod{Status: corev1.PodStatus{Conditions: []corev1.PodCondition{
		{Type: corev1.PodResizeInProgress, Status: corev1.ConditionTrue},
	}}}
	if r := resizePendingReason(p); r != "" {
		t.Fatalf("in progress is not pending: %q", r)
	}
	p.Status.Conditions = append(p.Status.Conditions, corev1.PodCondition{Type: corev1.PodResizePending, Status: corev1.ConditionTrue, Reason: "Deferred", Message: "node has no room"})
	if r := resizePendingReason(p); r != "Deferred: node has no room" {
		t.Fatalf("pending = %q", r)
	}
	if !ResizeKindAllowed("Deployment") || ResizeKindAllowed("Node") || containerIndex([]corev1.Container{{Name: "a"}, {Name: "b"}}, "b") != 1 {
		t.Fatal("kinds / container index")
	}
	res := &ResizeResult{Pods: []PodResizeResult{{Result: "resized"}, {Result: "skipped"}, {Result: "resized"}}}
	if res.count("resized") != 2 || res.count("error") != 0 {
		t.Fatal("count")
	}
}
