package k8s

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
)

// The answers that name an object for a drawer give its apiVersion, so the screen opens the right object of a Kind two
// groups serve: Widget of links-a.kubeast.io and of links-b.kubeast.io, both named dl-w in namespace e2e-detail-links.

const (
	linksNS = "e2e-detail-links"
	groupA  = "links-a.kubeast.io/v1"
	groupB  = "links-b.kubeast.io/v1"
)

func ownedBy(apiVersion, kind, name string) []metav1.OwnerReference {
	return []metav1.OwnerReference{{APIVersion: apiVersion, Kind: kind, Name: name, UID: types.UID("u-" + apiVersion), Controller: ptr(true)}}
}

// A result names its resource's apiVersion from the result's resources, else from the report's scope.
func TestPolicyReportRows_NameTheResourcesAPIVersion(t *testing.T) {
	report := &unstructured.Unstructured{}
	if err := json.Unmarshal([]byte(`{"apiVersion":"wgpolicyk8s.io/v1alpha2","kind":"PolicyReport","metadata":{"name":"dl","namespace":"`+linksNS+`"},
		"scope":{"apiVersion":"`+groupA+`","kind":"Widget","name":"dl-w","namespace":"`+linksNS+`"},
		"results":[
			{"policy":"scope","result":"fail"},
			{"policy":"resources","result":"fail","resources":[{"apiVersion":"`+groupB+`","kind":"Widget","name":"dl-w","namespace":"`+linksNS+`"}]},
			{"policy":"pod","result":"warn","resources":[{"apiVersion":"v1","kind":"Pod","name":"p1"}]},
			{"policy":"no-version","result":"warn","resources":[{"kind":"ConfigMap","name":"c1"}]}]}`), &report.Object); err != nil {
		t.Fatal(err)
	}
	got := map[string][3]string{}
	for _, r := range policyReportRows(report) {
		got[r.Policy] = [3]string{r.Kind, r.Name, r.APIVersion}
	}
	want := map[string][3]string{
		"scope":      {"Widget", "dl-w", groupA},
		"resources":  {"Widget", "dl-w", groupB},
		"pod":        {"Pod", "p1", "v1"},
		"no-version": {"ConfigMap", "c1", ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rows (kind, name, apiVersion) = %v, want %v", got, want)
	}
}

// Warning events about two groups' objects of one Kind and name are two issues, each with its object's apiVersion.
func TestIssues_EventsAboutTwoGroupsObjects(t *testing.T) {
	now := time.Now()
	event := func(name, apiVersion, reason string, ago time.Duration) corev1.Event {
		return corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: name, Namespace: linksNS},
			InvolvedObject: corev1.ObjectReference{APIVersion: apiVersion, Kind: "Widget", Namespace: linksNS, Name: "dl-w"},
			Type:           corev1.EventTypeWarning, Reason: reason, Message: reason + " by the test",
			LastTimestamp: metav1.NewTime(now.Add(-ago)), Count: 1,
		}
	}
	api := &pagedAPI{events: []corev1.Event{
		event("a-new", groupA, "LinksANew", time.Minute), event("b-new", groupB, "LinksBNew", 2*time.Minute), event("a-old", groupA, "LinksAOld", 3*time.Minute),
	}}
	rows, err := api.serve(t).warningEventRows(context.Background(), now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	issues := mergeEvents(nil, rows, now, time.Hour)
	got := map[string][2]string{}
	for _, is := range issues {
		got[is.ID] = [2]string{is.APIVersion, is.Reason}
	}
	want := map[string][2]string{
		"Widget.links-a.kubeast.io/" + linksNS + "/dl-w": {groupA, "LinksANew"},
		"Widget.links-b.kubeast.io/" + linksNS + "/dl-w": {groupB, "LinksBNew"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("issues (apiVersion, reason) = %v, want %v", got, want)
	}
}

// Pods two groups' Widgets of one name control are a finding each, with their owner's apiVersion — the same from the
// pods as a list and folded a page at a time.
func TestHygiene_OwnersOfTwoGroups(t *testing.T) {
	pod := func(name, apiVersion string) corev1.Pod {
		p := compliantPod(linksNS, name)
		p.Spec.Containers[0].Resources.Limits = nil // a finding: no memory limit
		p.OwnerReferences = ownedBy(apiVersion, "Widget", "dl-w")
		return p
	}
	pods := []corev1.Pod{pod("dl-pod-a", groupA), pod("dl-pod-b", groupB), pod("dl-pod-b2", groupB)}
	objs := make([]k8sruntime.Object, len(pods))
	for i := range pods {
		objs[i] = &pods[i]
	}
	opts := HygieneOptions{TargetMinor: 38}
	sum, err := hygienePodSummaryOf(context.Background(), fake.NewClientset(objs...), hygieneTarget(opts, ""))
	if err != nil {
		t.Fatal(err)
	}
	ns := []corev1.Namespace{labeledNS(linksNS)}
	for way, rep := range map[string]HygieneReport{
		"listed": EvaluateHygiene(HygieneInput{Pods: pods, Namespaces: ns, Failed: map[string]bool{}}, opts),
		"folded": EvaluateHygiene(HygieneInput{podSummary: sum, Namespaces: ns, Failed: map[string]bool{}}, opts),
	} {
		got := map[string]int{}
		for _, f := range findingsOf(rep, "resources.memory-limit") {
			got[f.Kind+" "+f.Name+" "+f.APIVersion] = max(f.Pods, 1)
		}
		want := map[string]int{"Widget dl-w " + groupA: 1, "Widget dl-w " + groupB: 2}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: memory-limit findings (owner → pods) = %v, want %v", way, got, want)
		}
	}
}

// The workload a pod belongs to comes with its apiVersion: a custom resource controller's, a ReplicaSet's Deployment,
// a Job's CronJob, a bare pod's; two groups' Widgets of one name are two Optimization rows.
func TestWorkloadOwner_NamesTheOwnersAPIVersion(t *testing.T) {
	rs := appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: linksNS, OwnerReferences: ownedBy("apps/v1", "Deployment", "web")}}
	job := batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "nightly-1", Namespace: linksNS, OwnerReferences: ownedBy("batch/v1", "CronJob", "nightly")}}
	s := newClusterDrawersService(t, &clusterDrawersAPI{objects: map[string]interface{}{
		"/apis/apps/v1/namespaces/" + linksNS + "/replicasets": appsv1.ReplicaSetList{Items: []appsv1.ReplicaSet{rs}},
		"/apis/batch/v1/namespaces/" + linksNS + "/jobs":       batchv1.JobList{Items: []batchv1.Job{job}},
	}})
	owner, err := s.workloadOwner(context.Background(), linksNS)
	if err != nil {
		t.Fatal(err)
	}
	pod := func(name string, refs []metav1.OwnerReference) corev1.Pod {
		return corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: linksNS, OwnerReferences: refs},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning},
		}
	}
	pods := []corev1.Pod{
		pod("dl-pod-a", ownedBy(groupA, "Widget", "dl-w")), pod("dl-pod-b", ownedBy(groupB, "Widget", "dl-w")),
		pod("web-1-x", ownedBy("apps/v1", "ReplicaSet", "web-1")), pod("nightly-1-x", ownedBy("batch/v1", "Job", "nightly-1")), pod("bare", nil),
	}
	got := [][3]string{}
	for _, p := range pods {
		k, n, v := owner(p)
		got = append(got, [3]string{k, n, v})
	}
	want := [][3]string{{"Widget", "dl-w", groupA}, {"Widget", "dl-w", groupB}, {"Deployment", "web", "apps/v1"}, {"CronJob", "nightly", "batch/v1"}, {"Pod", "bare", "v1"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("owners = %v, want %v", got, want)
	}
	widgets := map[string]int{}
	for _, r := range optimizationRows(pods, owner, map[usageKey]usageSample{}) {
		if r.Kind == "Widget" {
			widgets[r.APIVersion] += r.Pods
		}
	}
	if !reflect.DeepEqual(widgets, map[string]int{groupA: 1, groupB: 1}) {
		t.Fatalf("Widget rows (apiVersion → pods) = %v, want a row per group", widgets)
	}
}

// A Pod's owner references carry their apiVersion, so the drawer's owner link opens that group's object.
func TestDescribePod_OwnerReferencesNameTheirAPIVersion(t *testing.T) {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "dl-pod-b", Namespace: linksNS, OwnerReferences: ownedBy(groupB, "Widget", "dl-w")},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}
	s := newClusterDrawersService(t, &clusterDrawersAPI{objects: map[string]interface{}{"/api/v1/namespaces/" + linksNS + "/pods/dl-pod-b": p}})
	out, err := s.DescribePod(context.Background(), linksNS, "dl-pod-b")
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := asWire(out).(map[string]interface{})
	want := []interface{}{map[string]interface{}{"api_version": groupB, "kind": "Widget", "name": "dl-w", "uid": "u-" + groupB}}
	if !reflect.DeepEqual(wire["owner_references"], want) {
		t.Fatalf("owner_references = %#v, want %#v", wire["owner_references"], want)
	}
}
