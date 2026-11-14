package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// netstoreAPI answers each GET with the object stored under its path; an event list keeps the events its field
// selector's involvedObject fields pick, as the API server does.
func netstoreAPI(t *testing.T, objects map[string]interface{}) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		obj, ok := objects[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
			return
		}
		if el, ok := obj.(*corev1.EventList); ok {
			want := map[string]string{}
			for _, kv := range strings.Split(r.URL.Query().Get("fieldSelector"), ",") {
				if k, v, ok := strings.Cut(kv, "="); ok {
					want[k] = v
				}
			}
			kept := &corev1.EventList{}
			for _, e := range el.Items {
				if (want["involvedObject.name"] == "" || e.InvolvedObject.Name == want["involvedObject.name"]) &&
					(want["involvedObject.kind"] == "" || e.InvolvedObject.Kind == want["involvedObject.kind"]) {
					kept.Items = append(kept.Items, e)
				}
			}
			obj = kept
		}
		_ = json.NewEncoder(w).Encode(obj)
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

func netstoreEvent(kind, name, reason string, ago time.Duration) corev1.Event {
	at := metav1.NewTime(time.Now().Add(-ago).Truncate(time.Second))
	return corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: fmt.Sprintf("%s.%s", name, strings.ToLower(reason))},
		InvolvedObject: corev1.ObjectReference{Kind: kind, Name: name},
		Reason:         reason, Message: reason + " by the test", Type: "Normal", Count: 2,
		FirstTimestamp: at, LastTimestamp: at,
	}
}

// An Endpoints drawer reads describe whichever way it opened: the row's counts, each subset with its not-ready
// addresses, the object's uid and the events of the Endpoints (not those of the Service of the same name).
func TestDescribeEndpoints_SubsetsAndEvents(t *testing.T) {
	ep := &corev1.Endpoints{
		ObjectMeta: metav1.ObjectMeta{Name: "hand", Namespace: "ns", UID: "ep-uid", ResourceVersion: "42", Labels: map[string]string{"team": "numbers"}},
		Subsets: []corev1.EndpointSubset{
			{Addresses: []corev1.EndpointAddress{{IP: "10.255.1.1"}}, NotReadyAddresses: []corev1.EndpointAddress{{IP: "10.255.1.2"}, {IP: "10.255.1.3"}}, Ports: []corev1.EndpointPort{{Port: 7070, Protocol: corev1.ProtocolTCP}}},
			{Addresses: []corev1.EndpointAddress{{IP: "10.255.2.1"}}, Ports: []corev1.EndpointPort{{Name: "dns", Port: 53, Protocol: corev1.ProtocolUDP}}},
		},
	}
	s := netstoreAPI(t, map[string]interface{}{
		"/api/v1/namespaces/ns/endpoints/hand": ep,
		"/api/v1/namespaces/ns/events": &corev1.EventList{Items: []corev1.Event{
			withUID("ep-uid", netstoreEvent("Endpoints", "hand", "Mirrored", time.Minute)), netstoreEvent("Service", "hand", "Elsewhere", time.Second), withUID("ep-before", netstoreEvent("Endpoints", "hand", "OfTheOneBefore", time.Second)),
		}},
	})
	out, err := s.DescribeEndpoints(context.Background(), "ns", "hand")
	if err != nil {
		t.Fatalf("DescribeEndpoints: %v", err)
	}
	if out["ready_count"] != 2 || out["not_ready_count"] != 2 || out["uid"] != "ep-uid" || out["resource_version"] != "42" {
		t.Errorf("counts and metadata = %v %v %v %v", out["ready_count"], out["not_ready_count"], out["uid"], out["resource_version"])
	}
	subsets, _ := out["subsets"].([]map[string]interface{})
	if len(subsets) != 2 || len(subsets[0]["not_ready_addresses"].([]map[string]interface{})) != 2 {
		t.Errorf("subsets = %v", out["subsets"])
	}
	events, _ := out["events"].([]map[string]interface{})
	if len(events) != 1 || events[0]["reason"] != "Mirrored" || events[0]["count"] != int32(2) {
		t.Errorf("events = %v", out["events"])
	}
}

// An IngressClass drawer lists every Ingress of the class — by ingressClassName or the old annotation — not the
// first 50, and gets the class's events.
func TestIngressClass_EveryUserAndEvents(t *testing.T) {
	cls := "num-ic"
	ings := &networkingv1.IngressList{}
	for i := 0; i < 51; i++ {
		ings.Items = append(ings.Items, networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("spec-%02d", i), Namespace: "a"}, Spec: networkingv1.IngressSpec{IngressClassName: &cls}})
	}
	ings.Items = append(ings.Items,
		networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: "ann", Namespace: "b", Annotations: map[string]string{"kubernetes.io/ingress.class": cls}}},
		networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "b"}},
	)
	s := netstoreAPI(t, map[string]interface{}{
		"/apis/networking.k8s.io/v1/ingresses":             ings,
		"/apis/networking.k8s.io/v1/ingressclasses/num-ic": &networkingv1.IngressClass{ObjectMeta: metav1.ObjectMeta{Name: cls, UID: "ic-uid"}, Spec: networkingv1.IngressClassSpec{Controller: "numbers.kubeast.io/ingress"}},
		"/api/v1/events": &corev1.EventList{Items: []corev1.Event{withUID("ic-uid", netstoreEvent("IngressClass", cls, "Seen", time.Minute)), netstoreEvent("Ingress", cls, "Elsewhere", time.Minute), netstoreEvent("IngressClass", cls, "NamesNoUID", time.Minute)}},
	})
	users, err := s.ListIngressesByClass(context.Background(), cls)
	if err != nil {
		t.Fatalf("ListIngressesByClass: %v", err)
	}
	if len(users) != 52 || users[51]["name"] != "ann" {
		t.Errorf("users = %d, last %v; want 52, the annotated one last", len(users), users[len(users)-1]["name"])
	}
	out, err := s.DescribeIngressClass(context.Background(), cls)
	if err != nil {
		t.Fatalf("DescribeIngressClass: %v", err)
	}
	events, _ := out["events"].([]map[string]interface{})
	if len(events) != 1 || events[0]["reason"] != "Seen" || out["uid"] != "ic-uid" {
		t.Errorf("events = %v, uid = %v", out["events"], out["uid"])
	}
}

func sidecarPod(name string, uid types.UID, volumes []corev1.Volume) corev1.Pod {
	always := corev1.ContainerRestartPolicyAlways
	started := true
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ns", UID: uid},
		Spec: corev1.PodSpec{
			NodeName:       "node-1",
			InitContainers: []corev1.Container{{Name: "side", RestartPolicy: &always}},
			Containers:     []corev1.Container{{Name: "app"}},
			Volumes:        volumes,
		},
		Status: corev1.PodStatus{
			Phase:                 corev1.PodRunning,
			Conditions:            []corev1.PodCondition{{Type: corev1.PodInitialized, Status: corev1.ConditionTrue}},
			InitContainerStatuses: []corev1.ContainerStatus{{Name: "side", Ready: true, Started: &started, RestartCount: 2, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
			ContainerStatuses:     []corev1.ContainerStatus{{Name: "app", Ready: true, RestartCount: 1, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
		},
	}
}

// A ReplicaSet's describe keeps the row's owner references with `controller` (the drawer's Owner is the list's
// column), and its pods' STATUS, READY and RESTARTS are kubectl's — a sidecar counted.
func TestDescribeReplicaSet_OwnerAndPods(t *testing.T) {
	yes, no := true, false
	rs := &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "ns", OwnerReferences: []metav1.OwnerReference{
			{Kind: "ConfigMap", Name: "keep", UID: "cm", Controller: &no}, {Kind: "Rollout", Name: "web", UID: "ro", Controller: &yes},
		}},
		Spec: appsv1.ReplicaSetSpec{Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}},
	}
	pod := sidecarPod("web-1", "p1", nil)
	pod.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web", UID: "rs", Controller: &yes}}
	s := netstoreAPI(t, map[string]interface{}{
		"/apis/apps/v1/namespaces/ns/replicasets/web": rs,
		"/api/v1/namespaces/ns/events":                &corev1.EventList{},
		"/api/v1/namespaces/ns/pods":                  &corev1.PodList{Items: []corev1.Pod{pod}},
	})
	out, err := s.DescribeReplicaSet(context.Background(), "ns", "web")
	if err != nil {
		t.Fatalf("DescribeReplicaSet: %v", err)
	}
	refs, _ := out["owner_references"].([]map[string]interface{})
	got := make([]string, 0, len(refs))
	for _, r := range refs {
		got = append(got, fmt.Sprintf("%v/%v:%v", r["kind"], r["name"], r["controller"]))
	}
	if want := []string{"ConfigMap/keep:false", "Rollout/web:true"}; !reflect.DeepEqual(got, want) {
		t.Errorf("owner_references = %v, want %v", got, want)
	}
	if _, has := out["owner"]; has {
		t.Errorf("owner = %v: the drawer reads the owner references as the list does", out["owner"])
	}
	pods, _ := out["owned_pods"].([]map[string]interface{})
	if len(pods) != 1 || pods[0]["ready"] != "2/2" || pods[0]["restart_count"] != int32(3) || pods[0]["status"] != "Running" {
		t.Errorf("owned_pods = %v, want web-1 Running 2/2 with 3 restarts", out["owned_pods"])
	}
}

// The pods kubectl describe pvc lists as Used By (getPodsForPVC): the claim's mounts by name in the list's order,
// then the pod that owns it — a generic ephemeral volume's claim, mounted as that volume — with kubectl's STATUS,
// READY and RESTARTS. A pod with an ephemeral volume of the same name that does not own the claim is not one.
func pvcUsersFixture() (*corev1.PersistentVolumeClaim, []corev1.Pod) {
	claim := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "eph-scratch", Namespace: "ns",
		OwnerReferences: []metav1.OwnerReference{{Kind: "Pod", Name: "eph", UID: "owner"}}}, Spec: corev1.PersistentVolumeClaimSpec{VolumeName: "pv-1"}}
	ephemeral := corev1.Volume{Name: "scratch", VolumeSource: corev1.VolumeSource{Ephemeral: &corev1.EphemeralVolumeSource{}}}
	byName := corev1.Volume{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "eph-scratch"}}}
	owner := sidecarPod("eph", "owner", []corev1.Volume{ephemeral})
	user := sidecarPod("user", "user", []corev1.Volume{byName})
	initWait := sidecarPod("waiting", "waiting", []corev1.Volume{byName})
	initWait.Spec.InitContainers = []corev1.Container{{Name: "wait"}}
	initWait.Status = corev1.PodStatus{Phase: corev1.PodPending,
		InitContainerStatuses: []corev1.ContainerStatus{{Name: "wait", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
		ContainerStatuses:     []corev1.ContainerStatus{{Name: "app", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "PodInitializing"}}}}}
	stranger := sidecarPod("eph2", "stranger", []corev1.Volume{ephemeral})
	return claim, []corev1.Pod{owner, stranger, user, initWait}
}

func usedByRows(t *testing.T, out map[string]interface{}) []string {
	t.Helper()
	rows, _ := out["used_by_pods"].([]map[string]interface{})
	got := make([]string, 0, len(rows))
	for _, r := range rows {
		got = append(got, fmt.Sprintf("%v %v %v %v %v", r["name"], r["status"], r["ready"], r["restart_count"], r["volume_names"]))
	}
	return got
}

var wantUsedBy = []string{"user Running 2/2 3 [data]", "waiting Init:0/1 0/1 0 [data]", "eph Running 2/2 3 [scratch]"}

func TestDescribePVC_UsedByPodsAsKubectl(t *testing.T) {
	claim, pods := pvcUsersFixture()
	s := netstoreAPI(t, map[string]interface{}{
		"/api/v1/namespaces/ns/persistentvolumeclaims/eph-scratch": claim,
		"/api/v1/namespaces/ns/pods":                               &corev1.PodList{Items: pods},
		"/api/v1/namespaces/ns/events":                             &corev1.EventList{},
	})
	out, err := s.DescribePVC(context.Background(), "ns", "eph-scratch")
	if err != nil {
		t.Fatalf("DescribePVC: %v", err)
	}
	if got := usedByRows(t, out); !reflect.DeepEqual(got, wantUsedBy) {
		t.Errorf("used_by_pods = %q, want %q", got, wantUsedBy)
	}
}

// The PV drawer's Used By Pods are its claim's, the same rows; its CSI attributes come with describe, as the list's
// row has none.
func TestDescribePV_UsedByPodsAsKubectl(t *testing.T) {
	claim, pods := pvcUsersFixture()
	pv := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "pv-1"},
		Spec: corev1.PersistentVolumeSpec{
			ClaimRef:               &corev1.ObjectReference{Namespace: "ns", Name: "eph-scratch"},
			PersistentVolumeSource: corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{Driver: "d", VolumeHandle: "h", VolumeAttributes: map[string]string{"tier": "one"}}},
		},
	}
	s := netstoreAPI(t, map[string]interface{}{
		"/api/v1/persistentvolumes/pv-1":                           pv,
		"/api/v1/namespaces/ns/persistentvolumeclaims/eph-scratch": claim,
		"/api/v1/namespaces/ns/pods":                               &corev1.PodList{Items: pods},
		"/api/v1/events":                                           &corev1.EventList{},
	})
	out, err := s.DescribePV(context.Background(), "pv-1")
	if err != nil {
		t.Fatalf("DescribePV: %v", err)
	}
	if got := usedByRows(t, out); !reflect.DeepEqual(got, wantUsedBy) {
		t.Errorf("used_by_pods = %q, want %q", got, wantUsedBy)
	}
	if !reflect.DeepEqual(out["volume_attributes"], map[string]string{"tier": "one"}) {
		t.Errorf("volume_attributes = %v", out["volume_attributes"])
	}
}

// A drawer's pod table says what the Pods list says, as kubectl's printPod does: Terminating while a pod not finished
// is deleted, Unknown when its node was lost, a finished pod's own status.
func TestPodListView_Deleting(t *testing.T) {
	now := metav1.Now()
	running := sidecarPod("a", "a", nil)
	running.DeletionTimestamp = &now
	lost := running
	lost.Status.Reason = "NodeLost"
	done := corev1.Pod{ObjectMeta: metav1.ObjectMeta{DeletionTimestamp: &now}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "job"}}},
		Status: corev1.PodStatus{Phase: corev1.PodSucceeded, ContainerStatuses: []corev1.ContainerStatus{{Name: "job", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}}}}
	for _, c := range []struct {
		pod  corev1.Pod
		want string
	}{{running, "Terminating"}, {lost, "Unknown"}, {done, "Completed"}} {
		if got, _, _, _ := podListView(&c.pod); got != c.want {
			t.Errorf("%s: status %q, want %q", c.pod.Name, got, c.want)
		}
	}
}
