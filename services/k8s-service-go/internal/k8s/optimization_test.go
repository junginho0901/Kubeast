package k8s

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func optPod(name, ownerKind, ownerName, container string, phase corev1.PodPhase, req, lim corev1.ResourceList) corev1.Pod {
	ctrl := true
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ns"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: container, Resources: corev1.ResourceRequirements{Requests: req, Limits: lim}}}},
		Status:     corev1.PodStatus{Phase: phase},
	}
	if ownerKind != "" {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: ownerKind, Name: ownerName, Controller: &ctrl}}
	}
	return p
}

func rl(cpu, mem string) corev1.ResourceList {
	out := corev1.ResourceList{}
	if cpu != "" {
		out[corev1.ResourceCPU] = resource.MustParse(cpu)
	}
	if mem != "" {
		out[corev1.ResourceMemory] = resource.MustParse(mem)
	}
	return out
}

func testOwner(p corev1.Pod) (string, string) {
	c := metav1.GetControllerOf(&p)
	if c == nil || c.Kind == "Node" {
		return "Pod", p.Name
	}
	if c.Kind == "ReplicaSet" {
		return "Deployment", "web"
	}
	return c.Kind, c.Name
}

func TestOptimizationRows(t *testing.T) {
	pods := []corev1.Pod{
		optPod("web-abc-1", "ReplicaSet", "web-abc", "app", corev1.PodRunning, rl("500m", "512Mi"), rl("1", "1Gi")),
		optPod("web-abc-2", "ReplicaSet", "web-abc", "app", corev1.PodRunning, rl("500m", "512Mi"), rl("1", "1Gi")),
		optPod("db-0", "StatefulSet", "db", "postgres", corev1.PodRunning, rl("100m", "128Mi"), rl("", "")),
		optPod("bare", "", "", "sh", corev1.PodRunning, rl("", ""), rl("", "")),
		optPod("done", "Job", "once", "run", corev1.PodSucceeded, rl("1", "1Gi"), rl("1", "1Gi")),
	}
	usage := map[usageKey]usageSample{
		{"web-abc-1", "app"}: {cpuM: 40, memBytes: 200 << 20, hasCPU: true, hasMem: true},
		{"web-abc-2", "app"}: {cpuM: 55, memBytes: 180 << 20, hasCPU: true, hasMem: true},
		{"db-0", "postgres"}: {cpuM: 250, memBytes: 300 << 20, hasCPU: true, hasMem: true},
	}
	rows := optimizationRows(pods, testOwner, usage)
	if len(rows) != 3 {
		t.Fatalf("got %d rows: %+v", len(rows), rows)
	}
	web := rows[0]
	if web.Kind != "Deployment" || web.Name != "web" || web.Container != "app" || web.Pods != 2 {
		t.Fatalf("first row should be the over-provisioned web deployment: %+v", web)
	}
	if web.CPURequestM != 500 || web.CPULimitM != 1000 || web.MemRequestBytes != 512<<20 || web.MemLimitBytes != 1<<30 {
		t.Errorf("web requests/limits: %+v", web)
	}
	if *web.CPUUsageM != 55 || *web.CPURecommendM != 55 || *web.MemUsageBytes != 200<<20 || *web.MemRecommendBytes != 230<<20 {
		t.Errorf("web usage/recommend: cpu %d→%d mem %d→%d", *web.CPUUsageM, *web.CPURecommendM, *web.MemUsageBytes>>20, *web.MemRecommendBytes>>20)
	}
	if !reflect.DeepEqual(web.Flags, []string{"cpu_over", "mem_over"}) {
		t.Errorf("web flags = %v", web.Flags)
	}
	// No reclaimable request on the other two: ordered by kind/name.
	bare := rows[1]
	if bare.Kind != "Pod" || bare.Name != "bare" || bare.CPUUsageM != nil || !reflect.DeepEqual(bare.Flags, []string{"no_cpu_request", "no_mem_request", "no_mem_limit"}) {
		t.Errorf("bare: %+v", bare)
	}
	db := rows[2]
	if db.Kind != "StatefulSet" || !reflect.DeepEqual(db.Flags, []string{"no_mem_limit", "cpu_under", "mem_under"}) {
		t.Errorf("db: %+v", db)
	}

	noUsage := optimizationRows(pods, testOwner, map[usageKey]usageSample{})
	for _, r := range noUsage {
		if r.CPUUsageM != nil || r.CPURecommendM != nil || r.MemUsageBytes != nil || r.MemRecommendBytes != nil {
			t.Errorf("without usage no row should carry usage or recommendations: %+v", r)
		}
	}
}

func TestRecommendRounding(t *testing.T) {
	for in, want := range map[int64]int64{0: 10, 3: 10, 11: 15, 55: 55, 56: 60} {
		if got := recommendCPU(in); got != want {
			t.Errorf("recommendCPU(%d) = %d, want %d", in, got, want)
		}
	}
	if got := recommendMem(10 << 20); got != 100<<20 {
		t.Errorf("recommendMem(10Mi) = %dMi, want 100Mi", got>>20)
	}
	if got := recommendMem(200 << 20); got != 230<<20 {
		t.Errorf("recommendMem(200Mi) = %dMi, want 230Mi", got>>20)
	}
	if got := recommendMem(1<<30 + 1); got != 1178<<20 {
		t.Errorf("recommendMem(1Gi+1) = %dMi, want 1178Mi", got>>20)
	}
}
