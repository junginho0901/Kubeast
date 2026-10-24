package k8s

import (
	"context"
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
)

func owned(kind, name string) []metav1.OwnerReference {
	yes := true
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &yes}}
}

func TestNetdropsTarget(t *testing.T) {
	ctx := context.Background()
	sel := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}
	tmpl := corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "web"}}}
	pod := func(name, phase string, owner []metav1.OwnerReference) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "demo", Labels: map[string]string{"app": "web"}, OwnerReferences: owner},
			Status: corev1.PodStatus{Phase: corev1.PodPhase(phase)}}
	}
	cs := fake.NewClientset(
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "demo"}, Spec: appsv1.DeploymentSpec{Selector: sel, Template: tmpl}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-5f98b4964", Namespace: "demo", OwnerReferences: owned("Deployment", "web")}, Spec: appsv1.ReplicaSetSpec{Selector: sel, Template: tmpl}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "lone", Namespace: "demo"}, Spec: appsv1.ReplicaSetSpec{Selector: sel, Template: tmpl}},
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "backup-29000000", Namespace: "demo", OwnerReferences: owned("CronJob", "backup")}},
		&batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "backup", Namespace: "demo"}, Spec: batchv1.CronJobSpec{JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "backup"}}}}}}},
		pod("web-5f98b4964-b", "Running", owned("ReplicaSet", "web-5f98b4964")),
		pod("web-5f98b4964-a", "Running", owned("ReplicaSet", "web-5f98b4964")),
		pod("web-5f98b4964-done", "Succeeded", owned("ReplicaSet", "web-5f98b4964")),
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "bare", Namespace: "demo", Labels: map[string]string{"app": "bare"}}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "backup-29000000-x", Namespace: "demo", Labels: map[string]string{"app": "backup"}, OwnerReferences: owned("Job", "backup-29000000")},
			Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	)
	for _, c := range []struct {
		kind, name string
		wantPods   bool
		workload   *netdrops.Workload
		pods       []string
	}{
		{"", "", true, nil, nil},
		{"Pod", "web-5f98b4964-a", false, &netdrops.Workload{Kind: "Deployment", Name: "web"}, []string{"web-5f98b4964-a"}},
		{"Pod", "bare", false, nil, []string{"bare"}},
		{"Pod", "backup-29000000-x", false, &netdrops.Workload{Kind: "CronJob", Name: "backup"}, []string{"backup-29000000-x"}},
		{"ReplicaSet", "web-5f98b4964", false, &netdrops.Workload{Kind: "Deployment", Name: "web"}, nil},
		{"ReplicaSet", "lone", false, &netdrops.Workload{Kind: "ReplicaSet", Name: "lone"}, nil},
		{"Job", "backup-29000000", false, &netdrops.Workload{Kind: "CronJob", Name: "backup"}, nil},
		// pods: running ones only, sorted; a CronJob's by its template labels
		{"Deployment", "web", true, &netdrops.Workload{Kind: "Deployment", Name: "web"}, []string{"web-5f98b4964-a", "web-5f98b4964-b"}},
		{"CronJob", "backup", true, &netdrops.Workload{Kind: "CronJob", Name: "backup"}, []string{"backup-29000000-x"}},
	} {
		w, pods, truncated, err := netdropsTarget(ctx, cs, "demo", c.kind, c.name, c.wantPods)
		if err != nil || truncated || !reflect.DeepEqual(w, c.workload) || !reflect.DeepEqual(pods, c.pods) {
			t.Errorf("%s/%s: %+v %v %v %v", c.kind, c.name, w, pods, truncated, err)
		}
	}
	if _, _, _, err := netdropsTarget(ctx, cs, "demo", "Pod", "gone", false); err == nil {
		t.Fatal("a missing pod is an error")
	}
}
