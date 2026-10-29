package k8s

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// Each node's pods by colour, the pods not scheduled under "", the search on
// name or namespace as the page searched (not on the node).
func TestPodNodeSummary_CountsAndSearch(t *testing.T) {
	rows := []*podRow{
		row("a", "web-1", func(r *podRow) { r.node = "n1"; r.health = podHealthOK }),
		row("a", "web-2", func(r *podRow) { r.node = "n1"; r.health = podHealthError }),
		row("beta", "db-0", func(r *podRow) { r.node = "n2"; r.health = podHealthWarn }),
		row("beta", "pending-0", func(r *podRow) { r.node = ""; r.health = podHealthWarn }),
	}
	got := podNodeSummary(rows, "")
	want := []PodNodeCount{{Node: "", Total: 1, Warn: 1}, {Node: "n1", Total: 2, OK: 1, Error: 1}, {Node: "n2", Total: 1, Warn: 1}}
	if !reflect.DeepEqual(got.Nodes, want) || got.Total != 4 {
		t.Fatalf("all: %+v", got)
	}
	if got := podNodeSummary(rows, "WEB"); got.Total != 2 || got.All != 4 || len(got.Nodes) != 1 || got.Nodes[0].Node != "n1" {
		t.Fatalf("q=web: %+v", got)
	}
	if got := podNodeSummary(rows, "beta"); got.Total != 2 {
		t.Fatalf("q=beta matches the namespace: %+v", got)
	}
	if got := podNodeSummary(rows, "n1"); got.Total != 0 || len(got.Nodes) != 0 || got.Nodes == nil {
		t.Fatalf("q=n1 does not match a node name: %+v", got)
	}
}

// The map is served from the informer after the caller's access, with the same
// revision as the Pods list; a namespace-scoped caller counts its namespaces.
func TestGetPodNodeSummary_AccessAndRevision(t *testing.T) {
	ctx := context.Background()
	pods := []k8sruntime.Object{}
	for i, ns := range []string{"a", "a", "b", "c"} {
		p := overviewPod(ns, fmt.Sprintf("p%d", i), corev1.PodRunning)
		p.Spec.NodeName = []string{"n1", "n2", "n1", "n2"}[i]
		p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "c", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
		pods = append(pods, p)
	}
	s, _, _ := pageBundle(t, fake.NewSimpleClientset(pods...), func(string) bool { return true })
	sum, err := s.GetPodNodeSummary(ctx, "", "", "")
	if err != nil || sum.Total != 4 || len(sum.Nodes) != 2 || sum.Source != "index" || sum.Nodes[0].OK != 2 {
		t.Fatalf("all: %+v %v", sum, err)
	}
	again, err := s.GetPodNodeSummary(ctx, "", "", sum.Revision)
	if err != nil || !again.Unchanged || again.Nodes == nil {
		t.Fatalf("same revision: %+v %v", again, err)
	}

	scoped := auth.WithPayload(ctx, auth.TokenPayload{UserID: "u1", Namespaces: map[string][]string{"default": {"a", "c"}}})
	s, _, _ = pageBundle(t, fake.NewSimpleClientset(pods...), func(ns string) bool { return ns == "a" })
	sum, err = s.GetPodNodeSummary(scoped, "", "", "")
	if err != nil || sum.Total != 2 {
		t.Fatalf("scoped to a (c refused): %+v %v", sum, err)
	}
	if _, err := s.GetPodNodeSummary(scoped, "b", "", ""); !apierrors.IsForbidden(err) {
		t.Fatalf("scoped, b outside the grant: %v", err)
	}
}

// A node's pods are listed with the node's field selector, in the namespace
// chosen or in each namespace of a scoped grant; "" lists the pods not scheduled.
func TestListPodsOnNode(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewSimpleClientset(overviewPod("a", "p1", corev1.PodRunning), overviewPod("b", "p2", corev1.PodRunning))
	var asked []string
	cs.PrependReactor("list", "pods", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		fs := a.(k8stesting.ListActionImpl).GetListOptions().FieldSelector
		asked = append(asked, a.GetNamespace()+"|"+fs)
		return false, nil, nil
	})
	if _, err := listPodsOnNode(ctx, cs.CoreV1(), "n1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := listPodsOnNode(ctx, cs.CoreV1(), "", []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"|spec.nodeName=n1", "a|spec.nodeName=", "b|spec.nodeName="}
	if strings.Join(sortedCopy(asked), ",") != strings.Join(sortedCopy(want), ",") {
		t.Fatalf("lists %v, want %v", asked, want)
	}
	cs.PrependReactor("list", "pods", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", fmt.Errorf("no"))
	})
	if _, err := listPodsOnNode(ctx, cs.CoreV1(), "n1", []string{"a"}); !apierrors.IsForbidden(err) {
		t.Fatalf("refused: %v", err)
	}
	if _, err := callerNamespaces(auth.WithPayload(ctx, auth.TokenPayload{UserID: "u", Namespaces: map[string][]string{"default": {"a"}}}), "b"); !apierrors.IsForbidden(err) {
		t.Fatalf("outside the grant: %v", err)
	}
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}
