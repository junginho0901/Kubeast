package k8s

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The issue check of one namespace (the narrowing's) lists that namespace's objects and events, and the nodes whole.
func TestIssuesOfOneNamespaceReadThatNamespaceOnly(t *testing.T) {
	now := time.Now()
	pods := []corev1.Pod{
		{ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "shop"}, Status: corev1.PodStatus{Phase: corev1.PodPending}},
		{ObjectMeta: metav1.ObjectMeta{Name: "web-2", Namespace: "shop"}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	}
	api := &pagedAPI{pods: pods, events: someEvents(30, now)}
	s := api.serve(t)
	issues, err := s.CollectIssues(context.Background(), IssuesOptions{Now: now, Window: time.Hour, Namespace: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	pending := 0
	for _, is := range issues {
		if is.Kind == "Pod" && is.Name == "web-1" {
			pending++
		}
	}
	if pending != 1 {
		t.Fatalf("the pending pod: %+v", issues)
	}
	if len(api.asked) == 0 {
		t.Fatal("nothing was listed")
	}
	for _, a := range api.asked {
		if a.path != "/api/v1/nodes" && !strings.Contains(a.path, "/namespaces/shop/") {
			t.Errorf("a list outside the namespace: %s", a.path)
		}
	}
}
