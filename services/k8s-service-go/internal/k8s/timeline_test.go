package k8s

import (
	"fmt"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func rsOwnedBy(ns, name, owner, revision string, created time.Time) appsv1.ReplicaSet {
	return appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         ns,
			CreationTimestamp: metav1.NewTime(created),
			Annotations:       map[string]string{"deployment.kubernetes.io/revision": revision},
			OwnerReferences:   []metav1.OwnerReference{{Kind: "Deployment", Name: owner}},
		},
		Spec: appsv1.ReplicaSetSpec{
			Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "img:" + revision}}}},
		},
	}
}

// With NamespaceAll the Deployment and ReplicaSet lists span every namespace:
// a ReplicaSet is paired with the Deployment of the same name in its OWN
// namespace only, and entries keep their namespace.
func TestRolloutHistoryFromLists_AllNamespaces(t *testing.T) {
	now := time.Now()
	cutoff := now.Add(-time.Hour)
	deploys := &appsv1.DeploymentList{Items: []appsv1.Deployment{
		{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "alpha"}},
		{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "beta"}},
	}}
	rsList := &appsv1.ReplicaSetList{Items: []appsv1.ReplicaSet{
		rsOwnedBy("alpha", "web-1", "web", "2", now.Add(-10*time.Minute)),
		rsOwnedBy("beta", "api-1", "api", "5", now.Add(-20*time.Minute)),
		// "web" exists only in alpha: this beta ReplicaSet has no owner in beta.
		rsOwnedBy("beta", "web-9", "web", "9", now.Add(-5*time.Minute)),
		// older than the window
		rsOwnedBy("alpha", "web-0", "web", "1", now.Add(-2*time.Hour)),
	}}

	got := rolloutHistoryFromLists(deploys, rsList, cutoff)

	if len(got) != 2 {
		t.Fatalf("want 2 rollout entries, got %d: %v", len(got), got)
	}
	// newest first
	if got[0]["namespace"] != "alpha" || got[0]["name"] != "web" || got[0]["revision"] != int64(2) {
		t.Errorf("first entry = %v, want alpha/web rev 2", got[0])
	}
	if got[1]["namespace"] != "beta" || got[1]["name"] != "api" || got[1]["revision"] != int64(5) {
		t.Errorf("second entry = %v, want beta/api rev 5", got[1])
	}
	for _, e := range got {
		if e["namespace"] == "beta" && e["name"] == "web" {
			t.Errorf("beta/web-9 was paired with alpha's Deployment: %v", e)
		}
	}
}

// A namespace's rollouts are the StatefulSets' and DaemonSets' too: each ControllerRevision created in the window,
// named by its controlling owner (a revision owned by something else, or older, is not one).
func TestControllerRevisionRollouts(t *testing.T) {
	now := time.Now()
	cutoff := now.Add(-time.Hour)
	yes := true
	cr := func(name, ownerKind, owner string, rev int64, created time.Time) appsv1.ControllerRevision {
		return appsv1.ControllerRevision{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "shop", CreationTimestamp: metav1.NewTime(created),
				OwnerReferences: []metav1.OwnerReference{{Kind: ownerKind, Name: owner, Controller: &yes}}},
			Revision: rev,
		}
	}
	list := &appsv1.ControllerRevisionList{Items: []appsv1.ControllerRevision{
		cr("db-1", "StatefulSet", "db", 1, now.Add(-30*time.Minute)),
		cr("db-2", "StatefulSet", "db", 2, now.Add(-10*time.Minute)),
		cr("agent-1", "DaemonSet", "agent", 1, now.Add(-20*time.Minute)),
		cr("db-0", "StatefulSet", "db", 0, now.Add(-2*time.Hour)),
		cr("other-1", "Something", "other", 1, now.Add(-5*time.Minute)),
	}}
	got := controllerRevisionRollouts(list, cutoff)
	sortRolloutsNewestFirst(got)
	var names []string
	for _, e := range got {
		names = append(names, fmt.Sprintf("%s/%s#%d", e["kind"], e["name"], e["revision"]))
	}
	if want := "StatefulSet/db#2 DaemonSet/agent#1 StatefulSet/db#1"; strings.Join(names, " ") != want {
		t.Fatalf("rollouts %v, want %s", names, want)
	}
}
