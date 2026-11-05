package k8s

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A StatefulSet of apps/v1 and one of another group (OpenKruise's Advanced StatefulSet is Kind StatefulSet of
// apps.kruise.io) with the same name in one namespace: an Optimization row's resize and a workload drawer's policy
// violations take the pods of the row's or drawer's group only, and without an apiVersion pick by Kind and name as before.

const (
	tgNS    = "e2e-two-group"
	tgOther = "tg.kubeast.io/v1beta1"
)

func tgPod(name, ownerAPIVersion string) corev1.Pod {
	return corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: tgNS, OwnerReferences: ownedBy(ownerAPIVersion, "StatefulSet", "web")},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("50m"), corev1.ResourceMemory: resource.MustParse("200Mi")},
		}}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, QOSClass: corev1.PodQOSBurstable},
	}
}

func tgPods() []corev1.Pod {
	return []corev1.Pod{tgPod("web-0", "apps/v1"), tgPod("web-x-0", tgOther), tgPod("web-x-1", tgOther)}
}

// tgAPI answers the namespace's pods, ReplicaSets and Jobs, a pod by name, and records the pods sent a resize.
type tgAPI struct {
	pods    []corev1.Pod
	mu      sync.Mutex
	resized []string
}

func (a *tgAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	base := "/api/v1/namespaces/" + tgNS + "/pods"
	switch {
	case r.URL.Path == base:
		_ = json.NewEncoder(w).Encode(corev1.PodList{Items: a.pods})
	case r.URL.Path == "/apis/apps/v1/namespaces/"+tgNS+"/replicasets":
		_ = json.NewEncoder(w).Encode(appsv1.ReplicaSetList{})
	case r.URL.Path == "/apis/batch/v1/namespaces/"+tgNS+"/jobs":
		_ = json.NewEncoder(w).Encode(batchv1.JobList{})
	case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/resize"):
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, base+"/"), "/resize")
		a.mu.Lock()
		a.resized = append(a.resized, name)
		a.mu.Unlock()
		_, _ = io.Copy(io.Discard, r.Body)
		for _, p := range a.pods {
			if p.Name == name {
				_ = json.NewEncoder(w).Encode(p)
			}
		}
	case strings.HasPrefix(r.URL.Path, base+"/"):
		for _, p := range a.pods {
			if p.Name == strings.TrimPrefix(r.URL.Path, base+"/") {
				_ = json.NewEncoder(w).Encode(p)
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
	}
}

func newTwoGroupService(t *testing.T, api *tgAPI) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

// The row's apiVersion names its group: a group's pods only (any version of it); without one, every pod of that Kind
// and name; kind Pod names one pod whatever the apiVersion.
func TestMatchesResizeTarget_TheRowsGroup(t *testing.T) {
	s := newTwoGroupService(t, &tgAPI{pods: tgPods()})
	owner, err := s.workloadOwner(context.Background(), tgNS)
	if err != nil {
		t.Fatal(err)
	}
	pick := func(req ResizeRequest) []string {
		got := []string{}
		for _, p := range tgPods() {
			if matchesResizeTarget(&p, req, owner) {
				got = append(got, p.Name)
			}
		}
		return got
	}
	for _, c := range []struct {
		req  ResizeRequest
		want []string
	}{
		{ResizeRequest{Kind: "StatefulSet", Name: "web", APIVersion: "apps/v1"}, []string{"web-0"}},
		{ResizeRequest{Kind: "StatefulSet", Name: "web", APIVersion: tgOther}, []string{"web-x-0", "web-x-1"}},
		{ResizeRequest{Kind: "StatefulSet", Name: "web", APIVersion: "tg.kubeast.io/v1"}, []string{"web-x-0", "web-x-1"}},
		{ResizeRequest{Kind: "StatefulSet", Name: "web"}, []string{"web-0", "web-x-0", "web-x-1"}},
		{ResizeRequest{Kind: "Pod", Name: "web-x-1", APIVersion: "apps/v1"}, []string{"web-x-1"}},
	} {
		if got := pick(c.req); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%+v picks %v, want %v", c.req, got, c.want)
		}
	}
}

// The request's api_version reaches the pods the resize subresource is sent to, and the result (the audit record's
// after) names it; a request without it resizes every pod of the Kind and name, as before.
func TestResizeWorkload_OnlyTheRowsGroup(t *testing.T) {
	var req ResizeRequest
	if err := json.Unmarshal([]byte(`{"kind":"StatefulSet","name":"web","container":"app","mem_request_bytes":104857600,"api_version":"`+tgOther+`"}`), &req); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		req  ResizeRequest
		want []string
	}{
		{req, []string{"web-x-0", "web-x-1"}},
		{ResizeRequest{Kind: "StatefulSet", Name: "web", Container: "app", MemRequestBytes: req.MemRequestBytes}, []string{"web-0", "web-x-0", "web-x-1"}},
	} {
		api := &tgAPI{pods: tgPods()}
		s := newTwoGroupService(t, api)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		res, err := s.ResizeWorkload(ctx, tgNS, c.req)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		sort.Strings(api.resized)
		got := []string{}
		for _, p := range res.Pods {
			got = append(got, p.Pod+":"+p.Result)
		}
		want := []string{}
		for _, p := range c.want {
			want = append(want, p+":resized")
		}
		if !reflect.DeepEqual(api.resized, c.want) || !reflect.DeepEqual(got, want) || res.Resized != len(c.want) {
			t.Errorf("api_version %q: resize sent to %v, result %v (%d resized), want %v", c.req.APIVersion, api.resized, got, res.Resized, c.want)
		}
		after, _ := json.Marshal(res)
		var wire map[string]interface{}
		_ = json.Unmarshal(after, &wire)
		if av, _ := wire["api_version"].(string); av != c.req.APIVersion {
			t.Errorf("the result names api_version %q, want %q", av, c.req.APIVersion)
		}
	}
}

// A workload drawer's policy violations with its apiVersion: the results about the workload of that group and the pods
// its group's owner holds; a result naming no apiVersion counts for both; without an apiVersion, all of them as before.
func TestPolicyReportsForResource_OwnersOfTwoGroups(t *testing.T) {
	s := newTwoGroupService(t, &tgAPI{pods: tgPods()})
	policyReportCaches.mu.Lock()
	policyReportCaches.m = map[string]*policyReportCache{}
	policyReportCaches.mu.Unlock()
	row := func(kind, name, apiVersion, policy string) PolicyReportResult {
		return PolicyReportResult{Namespace: tgNS, Kind: kind, Name: name, APIVersion: apiVersion, Policy: policy, Result: "fail", Report: "r"}
	}
	c := policyReportCacheFor("default")
	c.mu.Lock()
	c.sets[tgNS+"|as:"] = policyReportSet{at: time.Now(), reports: 1, results: []PolicyReportResult{
		row("StatefulSet", "web", "apps/v1", "sts-apps"),
		row("StatefulSet", "web", tgOther, "sts-other"),
		row("StatefulSet", "web", "", "sts-no-version"),
		row("Pod", "web-0", "v1", "pod-apps"),
		row("Pod", "web-x-0", "v1", "pod-other-0"),
		row("Pod", "web-x-1", "v1", "pod-other-1"),
	}}
	c.mu.Unlock()
	for _, tc := range []struct {
		apiVersion string
		want       []string
	}{
		{"apps/v1", []string{"pod-apps", "sts-apps", "sts-no-version"}},
		{tgOther, []string{"pod-other-0", "pod-other-1", "sts-no-version", "sts-other"}},
		{"", []string{"pod-apps", "pod-other-0", "pod-other-1", "sts-apps", "sts-no-version", "sts-other"}},
	} {
		res, err := s.PolicyReportsForResource(context.Background(), tgNS, "StatefulSet", "web", tc.apiVersion, false)
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, r := range res.Rows {
			got = append(got, r.Policy)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, tc.want) || res.Totals.Fail != len(tc.want) {
			t.Errorf("apiVersion %q: rows %v (fail %d), want %v", tc.apiVersion, got, res.Totals.Fail, tc.want)
		}
	}
}

// A cluster-scoped custom resource's drawer with its apiVersion: the results about that group's object.
func TestPolicyReportsForClusterResource_TwoGroups(t *testing.T) {
	s := newTwoGroupService(t, &tgAPI{})
	policyReportCaches.mu.Lock()
	policyReportCaches.m = map[string]*policyReportCache{}
	policyReportCaches.mu.Unlock()
	row := func(apiVersion, policy string) PolicyReportResult {
		return PolicyReportResult{Kind: "Gizmo", Name: "g", APIVersion: apiVersion, Policy: policy, Result: "fail", Report: "c"}
	}
	c := policyReportCacheFor("default")
	c.mu.Lock()
	c.sets["*cluster|as:"] = policyReportSet{at: time.Now(), reports: 1, results: []PolicyReportResult{row(groupA, "a"), row(groupB, "b"), row("", "none")}}
	c.mu.Unlock()
	for _, tc := range []struct {
		apiVersion string
		want       []string
	}{
		{groupA, []string{"a", "none"}},
		{groupB, []string{"b", "none"}},
		{"", []string{"a", "b", "none"}},
	} {
		res, err := s.PolicyReportsForClusterResource(context.Background(), "Gizmo", "g", tc.apiVersion, false)
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, r := range res.Rows {
			got = append(got, r.Policy)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("apiVersion %q: rows %v, want %v", tc.apiVersion, got, tc.want)
		}
	}
}
