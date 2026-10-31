package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func summaryResources(req, lim map[corev1.ResourceName]string) corev1.ResourceRequirements {
	r := corev1.ResourceRequirements{Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{}}
	for k, v := range req {
		r.Requests[k] = resource.MustParse(v)
	}
	for k, v := range lim {
		r.Limits[k] = resource.MustParse(v)
	}
	return r
}

// The Namespace drawer's Resource Summary sums what the namespace's ResourceQuota counts as used: finished pods
// (Succeeded, Failed) hold nothing, an init container larger than the app containers sets the pod's value, a sidecar
// (an init container that restarts always) adds to it and the pod overhead is added. The phases still count every pod.
func TestNamespacePodSummary_SumsAsTheQuotaCountsUsed(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	cpu, mem := corev1.ResourceCPU, corev1.ResourceMemory
	pods := []corev1.Pod{
		{ // init container larger than the two app containers: 500m and 128Mi requested, 500m and 256Mi limited
			Spec: corev1.PodSpec{
				InitContainers: []corev1.Container{{Name: "init", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "500m", mem: "64Mi"}, map[corev1.ResourceName]string{cpu: "500m", mem: "64Mi"})}},
				Containers: []corev1.Container{
					{Name: "a", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "100m", mem: "128Mi"}, map[corev1.ResourceName]string{cpu: "200m", mem: "256Mi"})},
					{Name: "b", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "50m"}, nil)},
				},
			},
			Status: corev1.PodStatus{Phase: corev1.PodRunning},
		},
		{ // sidecar 30m beside 100m, with 10m and 16Mi of overhead: 140m and 16Mi requested, 140m limited
			Spec: corev1.PodSpec{
				InitContainers: []corev1.Container{{Name: "proxy", RestartPolicy: &always, Resources: summaryResources(map[corev1.ResourceName]string{cpu: "30m"}, map[corev1.ResourceName]string{cpu: "30m"})}},
				Containers:     []corev1.Container{{Name: "app", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "100m"}, map[corev1.ResourceName]string{cpu: "100m"})}},
				Overhead:       corev1.ResourceList{cpu: resource.MustParse("10m"), mem: resource.MustParse("16Mi")},
			},
			Status: corev1.PodStatus{Phase: corev1.PodPending},
		},
		{ // finished: counted in the phases, not summed
			Spec:   corev1.PodSpec{Containers: []corev1.Container{{Name: "job", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "1", mem: "1Gi"}, map[corev1.ResourceName]string{cpu: "1", mem: "1Gi"})}}},
			Status: corev1.PodStatus{Phase: corev1.PodSucceeded},
		},
		{
			Spec:   corev1.PodSpec{Containers: []corev1.Container{{Name: "job", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "2", mem: "2Gi"}, nil)}}},
			Status: corev1.PodStatus{Phase: corev1.PodFailed},
		},
		{ // no phase yet: Unknown, and summed as the quota does
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Resources: summaryResources(map[corev1.ResourceName]string{cpu: "5m", mem: "1Mi"}, nil)}}},
		},
	}
	var got namespacePodSummary
	for i := range pods {
		got.add(&pods[i])
	}
	const mi = 1 << 20
	if got.Total != 5 || got.Summed != 3 || got.Phases["Running"] != 1 || got.Phases["Pending"] != 1 || got.Phases["Succeeded"] != 1 || got.Phases["Failed"] != 1 || got.Phases["Unknown"] != 1 {
		t.Fatalf("counts %+v", got)
	}
	if got.CPURequestsM != 500+140+5 || got.MemoryRequests != (128+16+1)*mi {
		t.Fatalf("requests %dm %d, want 645m %d", got.CPURequestsM, got.MemoryRequests, (128+16+1)*mi)
	}
	if got.CPULimitsM != 500+140 || got.MemoryLimits != 256*mi {
		t.Fatalf("limits %dm %d, want 640m %d", got.CPULimitsM, got.MemoryLimits, 256*mi)
	}
}
