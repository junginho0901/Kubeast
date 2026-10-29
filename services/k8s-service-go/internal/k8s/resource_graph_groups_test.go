package k8s

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type podOpt func(*corev1.Pod)

func groupTestPod(name, ownerKind, owner, node string, opts ...podOpt) corev1.Pod {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Namespace: "shop", Name: name, Labels: map[string]string{"app": "web"},
			OwnerReferences: []metav1.OwnerReference{{Kind: ownerKind, Name: owner}},
		},
		Spec: corev1.PodSpec{
			NodeName:   node,
			Containers: []corev1.Container{{Name: "app"}},
			Volumes: []corev1.Volume{{Name: "cfg", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: "web-config"}}}}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: true,
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
		},
	}
	for _, o := range opts {
		o(&p)
	}
	return p
}

func crashing(p *corev1.Pod) {
	p.Status.ContainerStatuses[0].Ready = false
	p.Status.ContainerStatuses[0].State = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}
	p.Status.ContainerStatuses[0].RestartCount = 14
}

func labelled(k, v string) podOpt { return func(p *corev1.Pod) { p.Labels[k] = v } }

// webGraph: a ReplicaSet's n pods on two nodes, the Service and NetworkPolicy that select app=web.
func webGraph(n int, opts ...func(i int) []podOpt) *rgResources {
	res := &rgResources{
		replicaSets: []appsv1.ReplicaSet{{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-rs"}}},
		services: []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web"},
			Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "web"}}}},
		networkPolicies: []networkingv1.NetworkPolicy{{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-only"},
			Spec: networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}}}},
	}
	for i := 0; i < n; i++ {
		var o []podOpt
		for _, f := range opts {
			o = append(o, f(i)...)
		}
		node := "node-a"
		if i%2 == 1 {
			node = "node-b"
		}
		p := groupTestPod(fmt.Sprintf("web-rs-%02d", i), "ReplicaSet", "web-rs", node, o...)
		res.pods = append(res.pods, toRGPod(&p))
	}
	return res
}

func groupsOf(nodes map[string]rgNode) []rgNode {
	var out []rgNode
	for _, n := range nodes {
		if n.Group {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind+out[i].ID < out[j].Kind+out[j].ID })
	return out
}

func podBoxes(nodes map[string]rgNode) []string {
	var out []string
	for _, n := range nodes {
		if n.Kind == "Pod" && !n.Group {
			out = append(out, n.Name)
		}
	}
	sort.Strings(out)
	return out
}

func edgesOf(edges []rgEdge, end string) map[string]int {
	out := map[string]int{}
	for _, e := range edges {
		if e.Source == end || e.Target == end {
			out[e.Source+" "+e.Type+" "+e.Target] = e.Count
		}
	}
	return out
}

var grouped = ResourceGraphOptions{GroupPods: true}

func TestGroupPods_MoreThanTenPodsOfAnOwner(t *testing.T) {
	nodes, _ := buildResourceGraph(webGraph(10), []string{"shop"}, grouped)
	if g := groupsOf(nodes); len(g) != 0 || len(podBoxes(nodes)) != 10 {
		t.Fatalf("10 pods: groups %v, pod boxes %d — want none and 10", g, len(podBoxes(nodes)))
	}
	nodes, edges := buildResourceGraph(webGraph(11), []string{"shop"}, grouped)
	g := groupsOf(nodes)
	if len(g) != 1 || g[0].Count != 11 || len(g[0].Members) != 11 || len(podBoxes(nodes)) != 0 {
		t.Fatalf("11 pods: groups %+v, pod boxes %v — want one group of 11", g, podBoxes(nodes))
	}
	if g[0].Kind != "Pod" || g[0].Status != "Running" || g[0].OwnerKind != "ReplicaSet" || g[0].OwnerName != "web-rs" || g[0].Members[0] != "web-rs-00" {
		t.Fatalf("group = %+v", g[0])
	}
	// every edge of a member is one edge of the group, counted 11 times
	want := map[string]int{
		"ReplicaSet/shop/web-rs owns " + g[0].ID:                11,
		"Service/shop/web selects " + g[0].ID:                   11,
		"NetworkPolicy/shop/web-only network_policy " + g[0].ID: 11,
		g[0].ID + " mounts ConfigMap/shop/web-config":           11,
	}
	if got := edgesOf(edges, g[0].ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("group edges = %v, want %v", got, want)
	}
}

func TestGroupPods_ProblemPodsAndOtherEdgesStayApart(t *testing.T) {
	res := webGraph(14, func(i int) []podOpt {
		switch i {
		case 3:
			return []podOpt{crashing}
		case 5, 6:
			// left out of the NetworkPolicy and the Service: their edges differ
			return []podOpt{func(p *corev1.Pod) { p.Labels["app"] = "web-canary" }}
		}
		return nil
	})
	nodes, edges := buildResourceGraph(res, []string{"shop"}, grouped)
	g := groupsOf(nodes)
	if len(g) != 2 {
		t.Fatalf("groups = %+v, want the 11 alike and the 2 canaries", g)
	}
	sort.Slice(g, func(i, j int) bool { return g[i].Count > g[j].Count })
	if g[0].Count != 11 || g[1].Count != 2 || !reflect.DeepEqual(g[1].Members, []string{"web-rs-05", "web-rs-06"}) {
		t.Fatalf("groups = %+v", g)
	}
	if got := podBoxes(nodes); !reflect.DeepEqual(got, []string{"web-rs-03"}) {
		t.Fatalf("pod boxes = %v, want the crashing pod alone", got)
	}
	if _, ok := edgesOf(edges, g[1].ID)["Service/shop/web selects "+g[1].ID]; ok {
		t.Fatal("the canaries' group has the Service edge they do not have")
	}
	if c := edgesOf(edges, "Pod/shop/web-rs-03")["Service/shop/web selects Pod/shop/web-rs-03"]; c != 0 {
		t.Fatalf("a pod box's edge carries count %d", c)
	}
}

func TestGroupPods_TheNodeGroupingSplitsGroups(t *testing.T) {
	nodes, _ := buildResourceGraph(webGraph(24), []string{"shop"}, ResourceGraphOptions{GroupPods: true, GroupBy: "node"})
	g := groupsOf(nodes)
	if len(g) != 2 || g[0].Count != 12 || g[1].Count != 12 {
		t.Fatalf("groups = %+v, want 12 on each node", g)
	}
	got := []string{g[0].NodeName, g[1].NodeName}
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"node-a", "node-b"}) {
		t.Fatalf("group nodes = %v", got)
	}
	// without the node grouping the same pods are one group, which carries no node
	nodes, _ = buildResourceGraph(webGraph(24), []string{"shop"}, grouped)
	if g := groupsOf(nodes); len(g) != 1 || g[0].NodeName != "" {
		t.Fatalf("groups = %+v", g)
	}
}

func TestGroupPods_StatefulSetClaimsAndVolumesGroupWithThePods(t *testing.T) {
	res := &rgResources{}
	for i := 0; i < 12; i++ {
		name := fmt.Sprintf("db-%d", i)
		p := groupTestPod(name, "StatefulSet", "db", "node-a", func(p *corev1.Pod) {
			p.Labels = map[string]string{"app": "db"}
			p.Spec.Volumes = []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data-" + name}}}}
		})
		res.pods = append(res.pods, toRGPod(&p))
		res.pvcs = append(res.pvcs, corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "data-" + name},
			Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: "pv-" + name},
			Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
		})
		res.pvs = append(res.pvs, corev1.PersistentVolume{
			ObjectMeta: metav1.ObjectMeta{Name: "pv-" + name},
			Spec:       corev1.PersistentVolumeSpec{StorageClassName: "standard"},
			Status:     corev1.PersistentVolumeStatus{Phase: corev1.VolumeBound},
		})
	}
	nodes, edges := buildResourceGraph(res, []string{"shop"}, grouped)
	byKind := map[string]rgNode{}
	for _, g := range groupsOf(nodes) {
		byKind[g.Kind] = g
	}
	pods, claims, volumes := byKind["Pod"], byKind["PersistentVolumeClaim"], byKind["PersistentVolume"]
	if pods.Count != 12 || claims.Count != 12 || volumes.Count != 12 {
		t.Fatalf("groups = pods %d, claims %d, volumes %d — want 12 each", pods.Count, claims.Count, volumes.Count)
	}
	if claims.Name != "data-db-*" || claims.Status != "Bound" || claims.Members[0] != "data-db-0" || volumes.Status != "Bound" {
		t.Fatalf("claims = %+v, volumes = %+v", claims, volumes)
	}
	for _, n := range nodes {
		if !n.Group && (n.Kind == "PersistentVolumeClaim" || n.Kind == "PersistentVolume" || n.Kind == "Pod") {
			t.Fatalf("%s %s is still a box of its own", n.Kind, n.Name)
		}
	}
	want := map[string]int{
		pods.ID + " mounts " + claims.ID:                  12,
		claims.ID + " bound_to " + volumes.ID:             12,
		"StorageClass//standard provisions " + volumes.ID: 12,
	}
	for k, c := range want {
		found := false
		for _, e := range edges {
			if e.Source+" "+e.Type+" "+e.Target == k {
				found = true
				if e.Count != c {
					t.Fatalf("%s count %d, want %d", k, e.Count, c)
				}
			}
		}
		if !found {
			t.Fatalf("edge %s missing; edges %v", k, edges)
		}
	}
}

func TestGroupPods_ExpandAndOff(t *testing.T) {
	nodes, _ := buildResourceGraph(webGraph(12), []string{"shop"}, grouped)
	g := groupsOf(nodes)
	if len(g) != 1 {
		t.Fatalf("groups = %+v", g)
	}
	// the same graph read again names the group the same, so the page can expand it
	again, _ := buildResourceGraph(webGraph(12), []string{"shop"}, grouped)
	if groupsOf(again)[0].ID != g[0].ID {
		t.Fatal("the group's id changed between two reads")
	}
	expanded, expandedEdges := buildResourceGraph(webGraph(12), []string{"shop"}, ResourceGraphOptions{GroupPods: true, Expand: []string{g[0].ID}})
	off, offEdges := buildResourceGraph(webGraph(12), []string{"shop"}, ResourceGraphOptions{})
	if len(groupsOf(expanded)) != 0 || len(podBoxes(expanded)) != 12 || !reflect.DeepEqual(expandedEdges, offEdges) || !reflect.DeepEqual(podBoxes(off), podBoxes(expanded)) {
		t.Fatalf("expanded: groups %d, pod boxes %d — want the graph without groups", len(groupsOf(expanded)), len(podBoxes(expanded)))
	}
	for _, e := range offEdges {
		if e.Count != 0 || strings.HasPrefix(e.Source, "group:") || strings.HasPrefix(e.Target, "group:") {
			t.Fatalf("without groups an edge is %+v", e)
		}
	}
}
