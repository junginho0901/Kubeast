package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

func setPod(name, kind, owner string, phase corev1.PodPhase, waiting string) *corev1.Pod {
	yes := true
	p := overviewPod("a", name, phase)
	p.Labels = map[string]string{"app": "web"}
	if kind != "" {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: kind, Name: owner, Controller: &yes}}
	}
	if waiting != "" {
		p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: waiting}}}}
	}
	return p
}

// A workload drawer's table reads its owner's pods from the page: the answer names the owner it kept, changed or not, so
// a screen can tell a server that did not keep it.
func TestGetPodPage_SaysTheOwnerItKept(t *testing.T) {
	ctx := context.Background()
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(setPod("ds-1", "DaemonSet", "ds", corev1.PodRunning, ""), setPod("other", "ReplicaSet", "rs", corev1.PodRunning, "")),
		func(string) bool { return true })
	q := PodPageQuery{Namespace: "a", OwnerKind: "DaemonSet", OwnerName: "ds", Limit: 10}
	first, err := s.GetPodPage(ctx, q)
	if err != nil || first.Filters != (PodPageFilters{Namespace: "a", Owner: "DaemonSet/ds"}) || first.Total != 1 {
		t.Fatalf("filters %+v total %d (%v), want owner DaemonSet/ds and one pod", first.Filters, first.Total, err)
	}
	q.Revision = first.Revision
	again, err := s.GetPodPage(ctx, q)
	if err != nil || !again.Unchanged || again.Filters.Owner != "DaemonSet/ds" {
		t.Fatalf("unchanged answer %+v (%v), want the owner named", again, err)
	}
}

// A DaemonSet, ReplicaSet or StatefulSet describe, which an open drawer reads again on each change of its object, takes
// its owned pods from the pod rows once the informers serve: the same rows, and no list of the pods as the caller.
func TestOwnedPodsOfADescribeComeFromThePodRows(t *testing.T) {
	ctx := context.Background()
	// in the API server's order, by name
	pods := []*corev1.Pod{
		setPod("ds-a", "DaemonSet", "ds", corev1.PodRunning, ""),
		setPod("ds-b", "DaemonSet", "ds", corev1.PodPending, "ContainerCreating"),
		setPod("other", "ReplicaSet", "rs", corev1.PodRunning, ""),
	}
	objects := make([]k8sruntime.Object, 0, len(pods))
	list := corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}}
	for _, p := range pods {
		objects = append(objects, p)
		list.Items = append(list.Items, *p)
	}
	s, b, _ := pageBundle(t, fake.NewSimpleClientset(objects...), func(string) bool { return true })
	var listed atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/namespaces/a/pods" {
			http.NotFound(w, r)
			return
		}
		listed.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	}))
	defer api.Close()
	caller, err := kubernetes.NewForConfig(&rest.Config{Host: api.URL})
	if err != nil {
		t.Fatal(err)
	}
	b.clientset = caller
	if ci := b.overviewInformers(); ci == nil || !ci.waitSynced(ctx, 5*time.Second) {
		t.Fatal("the informers did not sync")
	}
	got, err := s.listOwnedPods(ctx, "a", "DaemonSet", "ds", &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}})
	if err != nil {
		t.Fatal(err)
	}
	row := func(name, status string) map[string]interface{} {
		return map[string]interface{}{"name": name, "namespace": "a", "status": status, "ready": "0/1", "restart_count": int32(0), "node_name": "", "pod_ip": "", "created_at": ""}
	}
	if want := []map[string]interface{}{row("ds-a", "Running"), row("ds-b", "ContainerCreating")}; !reflect.DeepEqual(got, want) {
		t.Errorf("owned pods %v, want %v", got, want)
	}
	if n := listed.Load(); n != 0 {
		t.Errorf("listed the pods as the caller %d times, want 0", n)
	}
}

// The pods of a drawer's set that need a look, as the floating chat counts them (podNotRunning): their Status, or the
// phase without one, is not Running, Completed or Succeeded. Counted over the rows matched, not the namespace.
func TestPodPage_CountsTheMatchedPodsThatNeedALook(t *testing.T) {
	in := newInterner()
	pods := []*corev1.Pod{
		setPod("running", "DaemonSet", "ds", corev1.PodRunning, ""),
		setPod("crashing", "DaemonSet", "ds", corev1.PodRunning, "CrashLoopBackOff"),
		setPod("pending", "DaemonSet", "ds", corev1.PodPending, ""),
		setPod("creating", "DaemonSet", "ds", corev1.PodPending, "ContainerCreating"),
		setPod("done", "DaemonSet", "ds", corev1.PodSucceeded, ""),
		setPod("failed", "DaemonSet", "ds", corev1.PodFailed, ""),
	}
	leaving := setPod("leaving", "DaemonSet", "ds", corev1.PodRunning, "")
	gone := metav1.NewTime(time.Unix(1_700_000_000, 0))
	leaving.DeletionTimestamp = &gone
	pods = append(pods, leaving)
	elsewhere := setPod("elsewhere", "DaemonSet", "ds", corev1.PodPending, "")
	elsewhere.Labels = map[string]string{"app": "other"}
	pods = append(pods, elsewhere, setPod("not-its-own", "ReplicaSet", "rs", corev1.PodPending, ""))
	rows := make([]*podRow, 0, len(pods))
	for _, p := range pods {
		rows = append(rows, toPodRow(p, in))
	}
	sel, _ := labels.Parse("app=web")
	page := buildPodPage(rowsOfOwner(rows, "DaemonSet", "ds"), PodPageQuery{LabelSelector: sel, Limit: 10}, time.Now())
	// crashing, pending, creating, failed and leaving (Terminating); not running, done, elsewhere or not-its-own
	if page.Total != 7 || page.NotRunning != 5 {
		t.Fatalf("total %d, not running %d, want 7 and 5 (%+v)", page.Total, page.NotRunning, page.Items)
	}
}
