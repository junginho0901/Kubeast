package k8s

import (
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
)

// namespacesAsListed are the namespaces clusterAPI lists, as the informers hold them.
func namespacesAsListed(names ...string) []k8sruntime.Object {
	made := metav1.NewTime(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	var out []k8sruntime.Object
	for _, ns := range names {
		out = append(out, &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{Name: ns, CreationTimestamp: made, Labels: map[string]string{"kubernetes.io/metadata.name": ns}},
			Status:     corev1.NamespaceStatus{Phase: corev1.NamespaceActive},
		})
	}
	return out
}

// A caller who may list namespaces gets its own list's answer, and with the overview asks one question and lists nothing.
func TestNamespacesOfACallerWhoMayListThemAreItsOwnList(t *testing.T) {
	names := []string{"kube-system", "a", "default", "b-2", "b"}
	api := &clusterAPI{namespaces: names, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, b := api.start(t, namespacesAsListed(names...)...)
	ctx := wideCaller("wide@example.com")
	own, err := b.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := make([]map[string]interface{}, 0, len(own.Items))
	for _, ns := range own.Items {
		want = append(want, map[string]interface{}{"name": ns.Name, "status": string(ns.Status.Phase), "created_at": toISO(&ns.CreationTimestamp), "labels": ns.Labels})
	}
	before := len(api.callsOf("wide@example.com"))

	var got []map[string]interface{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); got, err = s.GetNamespaces(ctx) }()
	go func() { defer wg.Done(); _, _ = s.GetClusterOverview(ctx) }()
	wg.Wait()
	if err != nil {
		t.Fatal(err)
	}
	if answerJSON(t, got) != answerJSON(t, want) {
		t.Errorf("namespaces\n got %s\nwant %s", answerJSON(t, got), answerJSON(t, want))
	}
	calls := api.callsOf("wide@example.com")[before:]
	lists, questions := 0, 0
	for _, c := range calls {
		switch {
		case c.verb == "list" && c.resource == "namespaces":
			lists++
		case c.verb == "review" && c.resource == "list namespaces":
			questions++
		}
	}
	if lists != 0 || questions != 1 {
		t.Errorf("namespaces with the overview: %d lists and %d questions of list namespaces as the caller, want 0 and 1", lists, questions)
	}
}

// A caller whose identity may not list namespaces gets the cluster's own answer to its list.
func TestNamespacesOfACallerTheCheckRefusesAreTheClustersAnswer(t *testing.T) {
	api := &clusterAPI{namespaces: []string{"a"}, review: rbac(map[string][]string{"wide@example.com": {""}})}
	s, _ := api.start(t, namespacesAsListed("a")...)
	if _, err := s.GetNamespaces(wideCaller("none@example.com")); !apierrors.IsForbidden(err) {
		t.Fatalf("refused: %v", err)
	}
	if n := api.count(func(c apiCall) bool {
		return c.user == "none@example.com" && c.verb == "list" && c.resource == "namespaces"
	}); n != 1 {
		t.Errorf("the refused caller's answer came from %d lists of its own, want the cluster's one", n)
	}
}
