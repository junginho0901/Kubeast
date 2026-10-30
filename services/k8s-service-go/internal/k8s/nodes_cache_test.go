package k8s

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// fullNode is a node as the API server sends it, with what the node list does not show: images, annotations,
// managed fields, condition times and messages.
func fullNode(name string) *corev1.Node {
	beat := metav1.NewTime(time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC))
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, UID: types.UID("uid-" + name), ResourceVersion: "1",
			CreationTimestamp: metav1.NewTime(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)),
			Labels:            map[string]string{"node-role.kubernetes.io/control-plane": "", "zone": "a"},
			Annotations:       map[string]string{"node.alpha.kubernetes.io/ttl": "0"},
			ManagedFields:     []metav1.ManagedFieldsEntry{{Manager: "kubelet"}},
		},
		Spec: corev1.NodeSpec{Unschedulable: true, Taints: []corev1.Taint{{Key: "k", Value: "v", Effect: corev1.TaintEffectNoSchedule}}, PodCIDR: "10.0.0.0/24"},
		Status: corev1.NodeStatus{
			Capacity:    corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("4"), corev1.ResourceMemory: resource.MustParse("8Gi")},
			Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("3900m"), corev1.ResourceMemory: resource.MustParse("7Gi")},
			Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue, Reason: "KubeletReady", Message: "kubelet is posting ready status", LastHeartbeatTime: beat, LastTransitionTime: beat},
				{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionFalse, Reason: "KubeletHasSufficientMemory", LastHeartbeatTime: beat},
			},
			Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: "10.0.0.1"}, {Type: corev1.NodeHostName, Address: name}},
			NodeInfo:  corev1.NodeSystemInfo{KubeletVersion: "v1.37.0", OSImage: "Debian", KernelVersion: "6.10", ContainerRuntimeVersion: "containerd://2.2", MachineID: "m", BootID: "b"},
			Images:    []corev1.ContainerImage{{Names: []string{"registry.k8s.io/pause:3.10"}, SizeBytes: 300000}},
		},
	}
}

// The stored node shows in the node list what the full one did, without what the list does not read.
func TestStripNode_KeepsWhatTheNodeListShows(t *testing.T) {
	full := fullNode("n1")
	stripped := stripNode(full)
	if got, want := formatNodeSummary(stripped), formatNodeSummary(full); !reflect.DeepEqual(got, want) {
		t.Fatalf("node list from the stored node:\n%v\nfrom the full node:\n%v", got, want)
	}
	if len(stripped.Status.Images) != 0 || len(stripped.Annotations) != 0 || len(stripped.ManagedFields) != 0 || stripped.Status.NodeInfo.BootID != "" {
		t.Fatalf("kept what the list does not show: %+v", stripped)
	}
	if c := stripped.Status.Conditions[0]; !c.LastHeartbeatTime.IsZero() || c.Message != "" {
		t.Fatalf("kept the condition's heartbeat or message: %+v", c)
	}
}

// A status heartbeat leaves the node list as it was; a change it shows does not.
func TestSameNodeView(t *testing.T) {
	a := stripNode(fullNode("n1"))
	beat := fullNode("n1")
	beat.ResourceVersion = "2"
	beat.Status.Conditions[0].LastHeartbeatTime = metav1.Now()
	if !sameNodeView(a, stripNode(beat)) {
		t.Fatal("a heartbeat counted as a change")
	}
	for name, change := range map[string]func(*corev1.Node){
		"ready":  func(n *corev1.Node) { n.Status.Conditions[0].Status = corev1.ConditionFalse },
		"label":  func(n *corev1.Node) { n.Labels = map[string]string{"zone": "b"} },
		"taint":  func(n *corev1.Node) { n.Spec.Taints = nil },
		"cordon": func(n *corev1.Node) { n.Spec.Unschedulable = false },
		"ip":     func(n *corev1.Node) { n.Status.Addresses[0].Address = "10.0.0.2" },
	} {
		n := fullNode("n1")
		change(n)
		if sameNodeView(a, stripNode(n)) {
			t.Errorf("%s: not counted as a change", name)
		}
	}
}

// nodesBundle is a bundle whose informers watch cs and whose caller's "list nodes" review answers allow.
func nodesBundle(t *testing.T, cs *fake.Clientset, allow bool) (*Service, *clientBundle, *int) {
	t.Helper()
	reviews := 0
	authz := fake.NewSimpleClientset()
	authz.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		reviews++
		ra := a.(k8stesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview).Spec.ResourceAttributes
		if ra.Verb != "list" || ra.Resource != "nodes" || ra.Namespace != "" {
			return true, nil, fmt.Errorf("unexpected review %+v", ra)
		}
		return true, &authorizationv1.SelfSubjectAccessReview{Status: authorizationv1.SubjectAccessReviewStatus{Allowed: allow}}, nil
	})
	s := &Service{}
	b := &clientBundle{cacheClient: cs, authz: authz.AuthorizationV1()}
	s.defaultBundle.Store(b)
	t.Cleanup(func() { _ = b.Close() })
	return s, b, &reviews
}

func nodeNames(items []map[string]interface{}) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it["name"].(string))
	}
	return out
}

// A caller the cluster lets list nodes gets the informers' list — by name, as a List returns it, the same rows —
// shared until a node changes what it shows; a caller it refuses, and a namespace-scoped grant, are left to the
// List as themselves.
func TestCachedNodes_ForACallerWhoMayListNodes(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset(fullNode("n3"), fullNode("n1"), fullNode("n2"))
	s, b, reviews := nodesBundle(t, cs, true)
	l, ok := s.cachedNodes(ctx)
	if !ok {
		t.Fatal("not served from the informers")
	}
	items := l.items
	if got := nodeNames(items); !reflect.DeepEqual(got, []string{"n1", "n2", "n3"}) {
		t.Fatalf("order %v", got)
	}
	if !reflect.DeepEqual(items[0], formatNodeSummary(fullNode("n1"))) {
		t.Fatalf("row %v", items[0])
	}
	if *reviews == 0 {
		t.Fatal("the caller's identity was never asked")
	}

	// the handler's bytes: what json.Encoder writes for the same items, encoded once
	var enc bytes.Buffer
	if err := json.NewEncoder(&enc).Encode(items); err != nil {
		t.Fatal(err)
	}
	raw, err := s.GetNodesJSON(ctx)
	if err != nil || !bytes.Equal(raw, enc.Bytes()) {
		t.Fatalf("JSON %v:\n%s\nencoder:\n%s", err, raw, enc.Bytes())
	}

	ci := b.syncedInformers()
	now := time.Now()
	first := ci.nodeSummaries(now)
	if again := ci.nodeSummaries(now); again != first || &again.JSON()[0] != &first.JSON()[0] {
		t.Fatal("the list or its JSON was built again with nothing changed in the same second")
	}

	// a heartbeat keeps the list; a cordon shows at once, in the same second
	n1, _ := cs.CoreV1().Nodes().Get(ctx, "n1", metav1.GetOptions{})
	n1.ResourceVersion = "2"
	n1.Status.Conditions[0].LastHeartbeatTime = metav1.Now()
	if _, err := cs.CoreV1().Nodes().UpdateStatus(ctx, n1, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 2*time.Second, func() bool {
		o, _, _ := ci.nodes.GetByKey("n1")
		return o.(*corev1.Node).ResourceVersion == "2"
	}) {
		t.Fatal("the heartbeat never reached the store")
	}
	time.Sleep(50 * time.Millisecond) // the handler runs after the store
	if again := ci.nodeSummaries(now); again != first {
		t.Fatal("a heartbeat rebuilt the list")
	}
	n1, _ = cs.CoreV1().Nodes().Get(ctx, "n1", metav1.GetOptions{})
	n1.Spec.Unschedulable = false
	if _, err := cs.CoreV1().Nodes().Update(ctx, n1, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if !eventually(t, 2*time.Second, func() bool {
		l := ci.nodeSummaries(now)
		return l.items[0]["unschedulable"] == false && bytes.Contains(l.JSON(), []byte(`"name":"n1","os_image":"Debian","roles":["control-plane"],"status":"Ready","taints"`))
	}) {
		t.Fatal("the cordon change did not show")
	}

	// refused: left to the List, which brings the cluster's refusal
	s, _, _ = nodesBundle(t, fake.NewSimpleClientset(fullNode("n1")), false)
	if _, ok := s.cachedNodes(ctx); ok {
		t.Fatal("served a caller the cluster refuses")
	}
	// a namespace-scoped grant lists as itself
	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a"}}})
	s, _, reviews = nodesBundle(t, fake.NewSimpleClientset(fullNode("n1")), true)
	if _, ok := s.cachedNodes(scoped); ok || *reviews != 0 {
		t.Fatalf("a namespace-scoped grant was served from the informers (reviews %d)", *reviews)
	}
}

// The callers holding every pod row take a place for as long as they hold them and give it back: a page and the node
// map, served from the informers as many times as there are places and more, leave every place free; a caller that
// finds every place taken waits, and gives up when its request does.
func TestPodRowSlots_TakenWhileTheRowsAreHeldAndGivenBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(pagePods()...), func(string) bool { return true })
	for i := 0; i < 2*cap(podRowSlots)+1; i++ {
		if _, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50}); err != nil {
			t.Fatalf("page %d: %v", i, err)
		}
		if _, err := s.GetPodNodeSummary(ctx, "", "", ""); err != nil {
			t.Fatalf("node map %d: %v", i, err)
		}
	}
	if n := len(podRowSlots); n != 0 {
		t.Fatalf("%d places still taken after the requests ended", n)
	}

	held := make([]func(), 0, cap(podRowSlots))
	for i := 0; i < cap(podRowSlots); i++ {
		release, err := takePodRowSlot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	gone, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	defer stop()
	if _, err := s.GetPodPage(gone, PodPageQuery{Limit: 50}); err == nil {
		t.Fatal("a page was built with every place taken")
	}
	held[0]()
	if _, err := s.GetPodPage(ctx, PodPageQuery{Limit: 50}); err != nil {
		t.Fatalf("after a place was given back: %v", err)
	}
	for _, release := range held[1:] {
		release()
	}
}
