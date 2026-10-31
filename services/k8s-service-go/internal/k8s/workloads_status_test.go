package k8s

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The list's status buckets for StatefulSets, DaemonSets and ReplicaSets: one that wants replicas and has none
// available is Unavailable. The "fewer ready than wanted" check ran first, so 0 of 2 read Degraded and the
// Unavailable card never counted anything (number check 10-31).
func TestWorkloadStatus_NoneAvailableIsUnavailable(t *testing.T) {
	cases := []struct {
		name                      string
		desired, ready, available int32
		want                      string
	}{
		{"none wanted", 0, 0, 0, "Idle"},
		{"none available", 2, 0, 0, "Unavailable"},
		{"some ready", 3, 1, 1, "Degraded"},
		{"all ready", 2, 2, 2, "Healthy"},
	}
	for _, c := range cases {
		replicas := c.desired
		sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "s"}, Spec: appsv1.StatefulSetSpec{Replicas: &replicas},
			Status: appsv1.StatefulSetStatus{ReadyReplicas: c.ready, AvailableReplicas: c.available}}
		ds := &appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: "d"},
			Status: appsv1.DaemonSetStatus{DesiredNumberScheduled: c.desired, NumberReady: c.ready, NumberAvailable: c.available}}
		rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "r"}, Spec: appsv1.ReplicaSetSpec{Replicas: &replicas},
			Status: appsv1.ReplicaSetStatus{ReadyReplicas: c.ready, AvailableReplicas: c.available}}
		for kind, got := range map[string]interface{}{
			"StatefulSet": formatStatefulSetDetail(sts)["status"],
			"DaemonSet":   formatDaemonSetDetail(ds)["status"],
			"ReplicaSet":  formatReplicaSetDetail(rs)["status"],
		} {
			if got != c.want {
				t.Errorf("%s %s (%d wanted, %d ready, %d available): status %v, want %s", kind, c.name, c.desired, c.ready, c.available, got, c.want)
			}
		}
	}
}
