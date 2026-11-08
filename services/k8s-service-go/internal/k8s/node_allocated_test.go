package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// nodePodsAPI serves a node and its pods as the API server does, field selectors included, and refuses the pod lists
// refusePods names.
type nodePodsAPI struct {
	node       corev1.Node
	pods       []corev1.Pod
	refusePods func(path string) int

	mu    sync.Mutex
	asked []string
	// lists of events, which across namespaces read every event the cluster holds
	eventLists int
}

// The Node drawer lists its events by itself and follows them, so its describe asks without them: a read that repeats as
// the node's pods change must not scan every event of the cluster each time.
func TestDescribeNode_AWindowThatFollowsItsEventsAsksWithoutThem(t *testing.T) {
	alloc := resourceList("cpu", "4", "memory", "16Gi")
	api := &nodePodsAPI{node: allocNode(alloc, alloc), pods: []corev1.Pod{
		allocPod("shop", "p", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "1"), nil)),
	}}
	s, _ := api.service(t)

	without, err := s.DescribeNodeWithoutEvents(context.Background(), "n1")
	if err != nil {
		t.Fatal(err)
	}
	api.mu.Lock()
	lists := api.eventLists
	api.mu.Unlock()
	if lists != 0 {
		t.Errorf("listed the events %d times", lists)
	}
	if _, ok := without["events"]; ok {
		t.Errorf("the answer holds events: %#v", without["events"])
	}
	if _, ok := without["events_error"]; ok {
		t.Errorf("the answer says the events could not be read: %#v", without["events_error"])
	}
	if got := allocatedRowsOf(t, without)[0]; got != [3]string{"cpu", "1 (25%)", "0 (0%)"} {
		t.Errorf("cpu row %v", got)
	}

	whole, err := s.DescribeNode(context.Background(), "n1")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := whole["events"]; !ok {
		t.Error("the describe the AI's tool and others read lost its events")
	}
}

func (a *nodePodsAPI) client(t *testing.T) *kubernetes.Clientset {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		switch {
		case r.URL.Path == "/api/v1/nodes/"+a.node.Name:
			_ = json.NewEncoder(w).Encode(a.node)
		case parts[len(parts)-1] == "pods":
			a.mu.Lock()
			a.asked = append(a.asked, r.URL.Path)
			a.mu.Unlock()
			if a.refusePods != nil {
				if code := a.refusePods(r.URL.Path); code != 0 {
					w.WriteHeader(code)
					_ = json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Code: int32(code), Reason: metav1.StatusReasonForbidden, Message: `pods is forbidden: User "u" cannot list resource "pods"`})
					return
				}
			}
			sel, err := fields.ParseSelector(r.URL.Query().Get("fieldSelector"))
			if err != nil {
				t.Errorf("field selector: %v", err)
			}
			items := []corev1.Pod{}
			for _, p := range a.pods {
				if len(parts) > 4 && parts[3] != p.Namespace {
					continue
				}
				if sel.Matches(fields.Set{"spec.nodeName": p.Spec.NodeName, "status.phase": string(p.Status.Phase)}) {
					items = append(items, p)
				}
			}
			_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, Items: items})
		case parts[len(parts)-1] == "events":
			a.mu.Lock()
			a.eventLists++
			a.mu.Unlock()
			_ = json.NewEncoder(w).Encode(corev1.EventList{TypeMeta: metav1.TypeMeta{Kind: "EventList", APIVersion: "v1"}})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Code: http.StatusNotFound, Reason: metav1.StatusReasonNotFound})
		}
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

func (a *nodePodsAPI) service(t *testing.T) (*Service, *kubernetes.Clientset) {
	t.Helper()
	cs := a.client(t)
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s, cs
}

func allocatedRowsOf(t *testing.T, out map[string]interface{}) [][3]string {
	t.Helper()
	wire, _ := asWire(out).(map[string]interface{})
	list, ok := wire["allocated_resources"].([]interface{})
	if !ok {
		t.Fatalf("allocated_resources = %#v, allocated_error = %#v", wire["allocated_resources"], wire["allocated_error"])
	}
	var rows [][3]string
	for _, item := range list {
		r, _ := item.(map[string]interface{})
		rows = append(rows, [3]string{r["resource"].(string), r["requests"].(string), r["limits"].(string)})
	}
	return rows
}

func resourceList(pairs ...string) corev1.ResourceList {
	out := corev1.ResourceList{}
	for i := 0; i+1 < len(pairs); i += 2 {
		out[corev1.ResourceName(pairs[i])] = resource.MustParse(pairs[i+1])
	}
	return out
}

func allocBox(name string, req, lim corev1.ResourceList) corev1.Container {
	return corev1.Container{Name: name, Resources: corev1.ResourceRequirements{Requests: req, Limits: lim}}
}

func allocPod(ns, name, node string, phase corev1.PodPhase, containers ...corev1.Container) corev1.Pod {
	return corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec:       corev1.PodSpec{NodeName: node, Containers: containers},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func allocNode(capacity, allocatable corev1.ResourceList) corev1.Node {
	return corev1.Node{
		TypeMeta:   metav1.TypeMeta{Kind: "Node", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "n1"},
		Status:     corev1.NodeStatus{Capacity: capacity, Allocatable: allocatable},
	}
}

type allocatedCase struct {
	name string
	node corev1.Node
	pods []corev1.Pod
	want [][3]string
}

// allocatedCases: every want is what kubectl's own describer of the module's version (k8s.io/kubectl v0.37.2
// describeNodeResource) prints for those objects. That package needs modules this one does not have, so it is not
// imported here; e2e number-check-node-allocated.spec.ts compares a live node with kubectl describe node.
func allocatedCases() []allocatedCase {
	always := corev1.ContainerRestartPolicyAlways

	withInit := allocPod("a", "init-peak", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "100m"), nil))
	withInit.Spec.InitContainers = []corev1.Container{allocBox("prep", resourceList("cpu", "1", "memory", "1Gi"), nil)}

	sidecar := allocBox("side", resourceList("cpu", "250m", "memory", "64Mi"), resourceList("memory", "128Mi"))
	sidecar.RestartPolicy = &always
	withSidecar := allocPod("b", "sidecar", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "150m", "memory", "128Mi"), resourceList("cpu", "500m", "memory", "256Mi")))
	withSidecar.Spec.InitContainers = []corev1.Container{sidecar}

	withOverhead := allocPod("b", "overhead", "n1", corev1.PodPending, allocBox("app", resourceList("cpu", "100m"), resourceList("cpu", "100m")))
	withOverhead.Spec.Overhead = resourceList("cpu", "50m", "memory", "10Mi")

	podLevel := allocPod("a", "pod-level", "n1", corev1.PodRunning, allocBox("app", nil, nil))
	podLevel.Spec.Resources = &corev1.ResourceRequirements{Requests: resourceList("cpu", "300m", "memory", "300Mi"), Limits: resourceList("cpu", "600m", "memory", "600Mi")}

	pods := []corev1.Pod{
		allocPod("a", "plain", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "950m", "memory", "290Mi", "ephemeral-storage", "2Gi"), resourceList("cpu", "2", "memory", "1Gi", "ephemeral-storage", "4Gi"))),
		allocPod("a", "gpu", "n1", corev1.PodRunning, allocBox("app", resourceList("nvidia.com/gpu", "2", "hugepages-2Mi", "64Mi"), resourceList("nvidia.com/gpu", "2", "hugepages-2Mi", "64Mi"))),
		allocPod("a", "no-requests", "n1", corev1.PodRunning, allocBox("app", nil, nil)),
		withInit, withSidecar, withOverhead, podLevel,
		// ended pods and another node's pods hold nothing here
		allocPod("a", "done", "n1", corev1.PodSucceeded, allocBox("app", resourceList("cpu", "4"), nil)),
		allocPod("a", "failed", "n1", corev1.PodFailed, allocBox("app", resourceList("cpu", "4"), nil)),
		allocPod("a", "elsewhere", "n2", corev1.PodRunning, allocBox("app", resourceList("cpu", "4"), nil)),
	}
	full := resourceList("cpu", "4", "memory", "16Gi", "ephemeral-storage", "100Gi", "hugepages-2Mi", "1Gi", "hugepages-1Gi", "0", "pods", "110", "nvidia.com/gpu", "8", "example.com/dongle", "3")
	everyKind := [][3]string{
		{"cpu", "2800m (70%)", "3250m (81%)"}, {"memory", "1816Mi (11%)", "2008Mi (12%)"}, {"ephemeral-storage", "2Gi (2%)", "4Gi (4%)"},
		{"hugepages-1Gi", "0 (0%)", "0 (0%)"}, {"hugepages-2Mi", "64Mi (6%)", "64Mi (6%)"},
		{"example.com/dongle", "0", "0"}, {"nvidia.com/gpu", "2", "2"},
	}
	return []allocatedCase{
		{"every kind of pod", allocNode(full, full), pods, everyKind},
		{"no allocatable: percents of the capacity", allocNode(full, nil), pods, everyKind},
		{"allocatable below the capacity", allocNode(full, resourceList("cpu", "3500m", "memory", "15Gi", "ephemeral-storage", "90Gi", "pods", "110")), pods, [][3]string{
			{"cpu", "2800m (80%)", "3250m (92%)"}, {"memory", "1816Mi (11%)", "2008Mi (13%)"}, {"ephemeral-storage", "2Gi (2%)", "4Gi (4%)"},
		}},
		{"a node that reports nothing", allocNode(nil, nil), pods, [][3]string{
			{"cpu", "2800m (0%)", "3250m (0%)"}, {"memory", "1816Mi (0%)", "2008Mi (0%)"}, {"ephemeral-storage", "2Gi (0%)", "4Gi (0%)"},
		}},
		{"no pods", allocNode(full, full), nil, [][3]string{
			{"cpu", "0 (0%)", "0 (0%)"}, {"memory", "0 (0%)", "0 (0%)"}, {"ephemeral-storage", "0 (0%)", "0 (0%)"},
			{"hugepages-1Gi", "0 (0%)", "0 (0%)"}, {"hugepages-2Mi", "0 (0%)", "0 (0%)"},
			{"example.com/dongle", "0", "0"}, {"nvidia.com/gpu", "0", "0"},
		}},
	}
}

// The drawer's Allocated Resources are kubectl describe node's: the pods on the node not Succeeded or Failed, each as
// the scheduler counts it (init containers at their peak, sidecars added, pod overhead and pod-level resources),
// percents of the allocatable cut to a whole number, hugepages and other resources after.
func TestDescribeNode_AllocatedResourcesAsKubectlDescribeNode(t *testing.T) {
	for _, c := range allocatedCases() {
		t.Run(c.name, func(t *testing.T) {
			api := &nodePodsAPI{node: c.node, pods: c.pods}
			s, _ := api.service(t)
			out, err := s.DescribeNode(context.Background(), "n1")
			if err != nil {
				t.Fatal(err)
			}
			if got := allocatedRowsOf(t, out); !reflect.DeepEqual(got, c.want) {
				t.Errorf("drawer %v\nwant   %v", got, c.want)
			}
		})
	}
}

// A grant limited to namespaces is not told about anyone else's pods: only its namespaces are listed and counted, and
// the answer says so. It never asks for the whole cluster's pods.
func TestDescribeNode_AllocatedOnlyTheNamespacesOfALimitedGrant(t *testing.T) {
	alloc := resourceList("cpu", "4", "memory", "16Gi")
	api := &nodePodsAPI{node: allocNode(alloc, alloc), pods: []corev1.Pod{
		allocPod("mine", "p", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "1"), nil)),
		allocPod("refused", "q", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "1"), nil)),
		allocPod("other", "r", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "2"), nil)),
	}, refusePods: func(path string) int {
		if strings.Contains(path, "/refused/") {
			return http.StatusForbidden
		}
		return 0
	}}
	s, _ := api.service(t)
	ctx := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u", Namespaces: map[string][]string{"default": {"mine", "refused"}}})
	out, err := s.DescribeNode(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := asWire(out).(map[string]interface{})
	if !reflect.DeepEqual(wire["allocated_scope"], []interface{}{"mine", "refused"}) {
		t.Errorf("allocated_scope = %#v", wire["allocated_scope"])
	}
	if got := allocatedRowsOf(t, out)[0]; got != [3]string{"cpu", "1 (25%)", "0 (0%)"} {
		t.Errorf("cpu row %v: only the pods of the namespaces read count", got)
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if len(api.asked) == 0 {
		t.Fatal("no pod list was made")
	}
	for _, path := range api.asked {
		if path == "/api/v1/pods" || strings.Contains(path, "/other/") {
			t.Errorf("asked %s for a grant limited to its namespaces", path)
		}
	}
}

// Pods that could not be read are no table of zeros: the reason, no rows, and the rest of the drawer still answers.
func TestDescribeNode_AllocatedSaysWhyWhenThePodsCouldNotBeRead(t *testing.T) {
	alloc := resourceList("cpu", "4")
	for _, c := range []struct {
		name   string
		code   int
		scoped bool
	}{{"refused", http.StatusForbidden, false}, {"failed", http.StatusInternalServerError, false}, {"a limited grant refused everywhere", http.StatusForbidden, true}} {
		t.Run(c.name, func(t *testing.T) {
			api := &nodePodsAPI{node: allocNode(alloc, alloc), refusePods: func(string) int { return c.code }}
			s, _ := api.service(t)
			ctx := context.Background()
			if c.scoped {
				ctx = auth.WithPayload(ctx, auth.TokenPayload{UserID: "u", Namespaces: map[string][]string{"default": {"a"}}})
			}
			out, err := s.DescribeNode(ctx, "n1")
			if err != nil {
				t.Fatal(err)
			}
			wire, _ := asWire(out).(map[string]interface{})
			if _, has := wire["allocated_resources"]; has {
				t.Errorf("allocated_resources = %#v, want none", wire["allocated_resources"])
			}
			reason, _ := wire["allocated_error"].(string)
			if !strings.Contains(reason, "pods is forbidden") {
				t.Errorf("allocated_error = %#v", wire["allocated_error"])
			}
			if wire["name"] != "n1" || wire["capacity"] == nil {
				t.Errorf("the rest of the answer is gone: %#v", wire)
			}
		})
	}
}

// GPU Feature Discovery writes nvidia.com/gpu.memory as a number of mebibytes, so the answer carries the unit the label
// leaves out. AMD's node labeller writes its own unit and Intel's rules no memory.
func TestGPUNodeLabels_MemoryCarriesItsUnit(t *testing.T) {
	for _, c := range []struct {
		vendor string
		labels map[string]string
		want   string
	}{
		{"NVIDIA", map[string]string{"nvidia.com/gpu.memory": "23034"}, "23034 MiB"},
		{"NVIDIA", map[string]string{}, ""},
		{"NVIDIA", map[string]string{"nvidia.com/gpu.memory": "24GB"}, "24GB"},
		{"AMD", map[string]string{"amd.com/gpu.vram": "192G"}, "192G"},
		{"Intel", map[string]string{"gpu.intel.com/product": "Max_1550"}, ""},
	} {
		if got := gpuNodeLabels(c.vendor, c.labels).memory; got != c.want {
			t.Errorf("%s %v: %q, want %q", c.vendor, c.labels, got, c.want)
		}
	}
}

// The Optimization window offers Apply on the kinds the resize route takes: the answer names exactly those.
func TestResizeKinds_AreTheKindsTheRouteTakes(t *testing.T) {
	kinds := ResizeKinds()
	want := []string{"CronJob", "DaemonSet", "Deployment", "Job", "Pod", "ReplicaSet", "StatefulSet"}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("ResizeKinds = %v, want %v", kinds, want)
	}
	for _, k := range kinds {
		if !ResizeKindAllowed(k) {
			t.Errorf("%s is named but not taken", k)
		}
	}
	if ResizeKindAllowed("Widget") {
		t.Error("Widget is taken")
	}
}

func TestOptimizationAnswer_NamesTheKindsItCanApply(t *testing.T) {
	api := &listAPI{pods: []corev1.Pod{allocPod("ns", "p", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "100m"), nil))}}
	res, err := api.serve(t).CollectOptimization(context.Background(), "ns", 24)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res.ResizeKinds, []string{"CronJob", "DaemonSet", "Deployment", "Job", "Pod", "ReplicaSet", "StatefulSet"}) {
		t.Errorf("resize_kinds = %v", res.ResizeKinds)
	}
}
