package k8s

import (
	"context"
	"errors"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func overviewPod(ns, name string, phase corev1.PodPhase) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: map[string]string{"app": name}},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Image: "x"}}},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func overviewObjects() []runtime.Object {
	return []runtime.Object{
		overviewPod("a", "p1", corev1.PodRunning),
		overviewPod("a", "p2", corev1.PodRunning),
		overviewPod("b", "p3", corev1.PodPending),
		overviewPod("b", "p4", corev1.PodFailed),
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "a"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "b"}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "a", Name: "s1"}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "a", Name: "d1"}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Namespace: "a", Name: "c1"}},
		&corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "pv1"}},
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "n1"},
			Status: corev1.NodeStatus{Capacity: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("4"),
				corev1.ResourceMemory: resource.MustParse("8Gi"),
			}},
		},
	}
}

func eventually(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

func TestClusterInformers_OverviewFromStore(t *testing.T) {
	cs := fake.NewSimpleClientset(overviewObjects()...)
	ci := newClusterInformers(cs, time.Hour, nil)
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}

	ov := ci.overview()
	want := map[string]int{"total_namespaces": 2, "total_pods": 4, "total_services": 1, "total_deployments": 1, "total_pvcs": 1, "total_pvs": 1, "node_count": 1}
	for k, v := range want {
		if ov[k] != v {
			t.Errorf("%s = %v, want %d", k, ov[k], v)
		}
	}
	status := ov["pod_status"].(map[string]int)
	if status["Running"] != 2 || status["Pending"] != 1 || status["Failed"] != 1 || status["Succeeded"] != 0 {
		t.Errorf("pod_status = %v", status)
	}
	caps := ci.nodeCapacities()
	if c := caps["n1"]; c.cpuNano != 4_000_000_000 || c.memBytes != 8<<30 {
		t.Errorf("n1 capacity = %+v", c)
	}

	// Reads are served from memory: no list per overview (the reflectors' own
	// watch calls are not counted; they are established asynchronously).
	lists := func() int {
		n := 0
		for _, a := range cs.Actions() {
			if a.GetVerb() == "list" {
				n++
			}
		}
		return n
	}
	before := lists()
	for i := 0; i < 50; i++ {
		ci.overview()
		ci.nodeCapacities()
	}
	if got := lists(); got != before {
		t.Errorf("overview issued %d list calls", got-before)
	}

	// The watch keeps the store current.
	if _, err := cs.CoreV1().Pods("a").Create(context.Background(), overviewPod("a", "p5", corev1.PodSucceeded), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 3*time.Second, func() bool { return ci.overview()["total_pods"] == 5 }) {
		t.Errorf("total_pods after create = %v, want 5", ci.overview()["total_pods"])
	}

	// Stored objects are stripped to key + phase.
	o, ok, _ := ci.pods.GetByKey("a/p1")
	if !ok {
		t.Fatal("a/p1 not in store")
	}
	p := o.(*corev1.Pod)
	if p.Labels != nil || len(p.Spec.Containers) != 0 || p.Status.Phase != corev1.PodRunning {
		t.Errorf("stored pod not stripped: labels=%v containers=%d phase=%s", p.Labels, len(p.Spec.Containers), p.Status.Phase)
	}
}

func TestClusterInformers_StopsWhenIdle(t *testing.T) {
	cs := fake.NewSimpleClientset(overviewObjects()...)
	stopped := make(chan bool, 1)
	ci := newClusterInformers(cs, 40*time.Millisecond, func(_ *clusterInformers, forbidden bool) { stopped <- forbidden })
	t.Cleanup(ci.stopNow)
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	select {
	case forbidden := <-stopped:
		if forbidden {
			t.Error("idle stop reported forbidden")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("informers did not stop when idle")
	}
	if !ci.isStopped() {
		t.Error("isStopped = false after idle stop")
	}
	if ci.waitSynced(context.Background(), 10*time.Millisecond) {
		t.Error("waitSynced = true on a stopped set")
	}
}

func forbiddenClientset() *fake.Clientset {
	cs := fake.NewSimpleClientset(overviewObjects()...)
	cs.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", errors.New("rbac"))
	})
	return cs
}

func TestClusterInformers_ForbiddenStops(t *testing.T) {
	stopped := make(chan bool, 1)
	ci := newClusterInformers(forbiddenClientset(), time.Hour, func(_ *clusterInformers, forbidden bool) { stopped <- forbidden })
	t.Cleanup(ci.stopNow)
	select {
	case forbidden := <-stopped:
		if !forbidden {
			t.Error("stop not reported as forbidden")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("forbidden list did not stop the informers")
	}
	if ci.waitSynced(context.Background(), 50*time.Millisecond) {
		t.Error("waitSynced = true after a forbidden list")
	}
}

func TestClientBundle_OverviewInformersRetryAfterForbidden(t *testing.T) {
	b := &clientBundle{cacheClient: forbiddenClientset()}
	ci := b.overviewInformers()
	if ci == nil {
		t.Fatal("first call did not start informers")
	}
	t.Cleanup(ci.stopNow)
	if !eventually(t, 5*time.Second, func() bool { b.infMu.Lock(); defer b.infMu.Unlock(); return b.inf == nil && !b.infFailedAt.IsZero() }) {
		t.Fatal("bundle did not record the forbidden stop")
	}
	if b.overviewInformers() != nil {
		t.Error("informers restarted before the retry interval")
	}
	if b.syncedInformers() != nil {
		t.Error("syncedInformers returned a stopped set")
	}
}

func TestClientBundle_CloseStopsInformers(t *testing.T) {
	b := &clientBundle{cacheClient: fake.NewSimpleClientset(overviewObjects()...)}
	ci := b.overviewInformers()
	if !ci.waitSynced(context.Background(), 5*time.Second) {
		t.Fatal("informers did not sync")
	}
	if b.syncedInformers() != ci {
		t.Error("syncedInformers did not return the running set")
	}
	_ = b.Close()
	if !ci.isStopped() {
		t.Error("Close did not stop the informers")
	}
	if b.syncedInformers() != nil {
		t.Error("syncedInformers after Close")
	}
}

// GetClusterOverview answers from the informers: the bundle has no clientset,
// so the List fallback would fail.
func TestService_GetClusterOverview_FromInformers(t *testing.T) {
	s := &Service{}
	b := &clientBundle{cacheClient: fake.NewSimpleClientset(overviewObjects()...)}
	s.defaultBundle.Store(b)
	t.Cleanup(func() { _ = b.Close() })

	ov, err := s.GetClusterOverview(context.Background())
	if err != nil {
		t.Fatalf("GetClusterOverview: %v", err)
	}
	if ov["total_pods"] != 4 || ov["node_count"] != 1 {
		t.Errorf("overview = %v", ov)
	}
	if _, ok := ov["cluster_version"]; !ok {
		t.Error("cluster_version missing")
	}
	caps := s.nodeCapacities(context.Background())
	if caps["n1"].cpuNano != 4_000_000_000 {
		t.Errorf("nodeCapacities = %+v", caps)
	}
}

func TestStripForOverview_PassesUnknownThrough(t *testing.T) {
	in := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "x"}}
	out, err := stripForOverview(in)
	if err != nil || out != in {
		t.Errorf("unknown kind changed: %v %v", out, err)
	}
}
