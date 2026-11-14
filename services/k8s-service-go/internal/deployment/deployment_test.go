package deployment

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A rollout holds the old ReplicaSet's pods and the new one's at once: kubectl describe prints them as
// "3 desired | 1 updated | 4 total | 2 available | 2 unavailable", and the row's current_replicas is that total.
func TestARowSaysThePodsTheDeploymentHoldsAsKubectlDescribeCountsTotal(t *testing.T) {
	desired := int32(3)
	d := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
		Spec:       appsv1.DeploymentSpec{Replicas: &desired},
		Status: appsv1.DeploymentStatus{
			Replicas:            4,
			UpdatedReplicas:     1,
			ReadyReplicas:       2,
			AvailableReplicas:   2,
			UnavailableReplicas: 2,
		},
	}
	row := Info(d)
	want := map[string]int32{"replicas": 3, "current_replicas": 4, "updated_replicas": 1, "available_replicas": 2, "unavailable_replicas": 2}
	for field, value := range want {
		if row[field] != value {
			t.Errorf("%s: got %v, want %d", field, row[field], value)
		}
	}
}

// A Deployment the controller has not seen yet has no status: no pods, not a missing field.
func TestARowOfANewDeploymentSaysNoPods(t *testing.T) {
	row := Info(&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}})
	if got, ok := row["current_replicas"]; !ok || got != int32(0) {
		t.Fatalf("current_replicas: got %v (present %v), want 0", got, ok)
	}
}
