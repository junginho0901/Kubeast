package k8s

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
)

// firstScreens is what one person's Dashboard, Pods and Cluster View ask at once, the can-i as its handler's one review.
func firstScreens(s *Service, b *clientBundle, ctx context.Context, nodes []string) {
	var wg sync.WaitGroup
	run := func(f func()) {
		wg.Add(1)
		go func() { defer wg.Done(); f() }()
	}
	run(func() { _, _ = s.GetNamespaces(ctx) })
	run(func() { _, _ = s.GetClusterOverview(ctx) })
	run(func() { _, _ = s.GetPodPage(ctx, PodPageQuery{Sort: "name", Limit: 50}) })
	run(func() { _, _ = s.GetNodesJSON(ctx) })
	run(func() { _, _ = s.GetPodNodeSummary(ctx, "", "", "") })
	run(func() {
		_, _ = b.authz.SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{Spec: authorizationv1.SelfSubjectAccessReviewSpec{
			ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: "create", Resource: "pods"},
		}}, metav1.CreateOptions{})
	})
	for _, node := range nodes {
		run(func() { _, _ = s.GetPodsOnNode(ctx, node, "") })
	}
	wg.Wait()
}

// The first screens of one person list no pods as that person: what is left is the questions of what it may see.
func TestFirstScreensOfOnePersonListNoPodsAsThatPerson(t *testing.T) {
	var namespaces []string
	for i := 0; i < 20; i++ {
		namespaces = append(namespaces, fmt.Sprintf("ns-%02d", i))
	}
	nodes := []string{"n0", "n1", "n2", "n3"}
	var pods []corev1.Pod
	var objs []k8sruntime.Object
	for i, ns := range namespaces {
		for _, node := range nodes {
			pods = append(pods, nodePod(ns, ns+"-"+node, node))
		}
		objs = append(objs, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}},
			&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: fmt.Sprintf("d%d", i)}},
			overviewPod(ns, "p", corev1.PodRunning))
	}
	grants := map[string][]string{"wide@example.com": {""}, "five@example.com": namespaces[:5], "twenty@example.com": namespaces}
	// what is left is a question per thing shown (7 for the overview, the can-i), and a grant's namespaces and nodes
	people := []struct {
		user    string
		ctx     context.Context
		n, want int
	}{
		{"wide@example.com", wideCaller("wide@example.com"), 0, 8},
		{"five@example.com", grantCaller("five@example.com", namespaces[:5]...), 5, 5*5 + 2},
		{"twenty@example.com", grantCaller("twenty@example.com", namespaces...), 20, 5*20 + 2},
	}
	var table []string
	for _, p := range people {
		api := &clusterAPI{pods: pods, namespaces: namespaces, review: rbac(grants)}
		s, b := api.start(t, objs...)
		firstScreens(s, b, p.ctx, nodes)
		byKind := map[string]int{}
		for _, c := range api.callsOf(p.user) {
			byKind[c.verb+" "+c.resource]++
		}
		kinds := make([]string, 0, len(byKind))
		for k, n := range byKind {
			kinds = append(kinds, fmt.Sprintf("%s=%d", k, n))
		}
		slices.Sort(kinds)
		asCache := api.count(func(c apiCall) bool { return c.user == overviewCacheUser })
		table = append(table, fmt.Sprintf("%-20s N=%-2d as the person %3d  as %s %d  (%s)", p.user, p.n, len(api.callsOf(p.user)), overviewCacheUser, asCache, strings.Join(kinds, " ")))
		if n := byKind["list pods"]; n != 0 {
			t.Errorf("%s: %d pod lists as the person, want 0", p.user, n)
		}
		if n := len(api.callsOf(p.user)); n != p.want {
			t.Errorf("%s: %d requests as the person, want %d", p.user, n, p.want)
		}
		if n := api.count(func(c apiCall) bool { return c.user == "" }); n != 0 {
			t.Errorf("%s: %d requests as Kubeast's own credential", p.user, n)
		}
	}
	t.Log("first screens of one person:\n" + strings.Join(table, "\n"))
}
