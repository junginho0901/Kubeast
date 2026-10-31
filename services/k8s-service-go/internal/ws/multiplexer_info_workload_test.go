package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// A watch event's status bucket is the list's (k8s formatStatefulSetDetail and the others): one that wants
// replicas and has none available is Unavailable, not Degraded (number check 10-31).
func TestWorkloadInfoStatus_NoneAvailableIsUnavailable(t *testing.T) {
	cases := []struct {
		name                      string
		desired, ready, available int64
		want                      string
	}{
		{"none wanted", 0, 0, 0, "Idle"},
		{"none available", 2, 0, 0, "Unavailable"},
		{"some ready", 3, 1, 1, "Degraded"},
		{"all ready", 2, 2, 2, "Healthy"},
	}
	meta := map[string]interface{}{"name": "w", "namespace": "a"}
	for _, c := range cases {
		sts := &unstructured.Unstructured{Object: map[string]interface{}{"metadata": meta,
			"spec":   map[string]interface{}{"replicas": c.desired},
			"status": map[string]interface{}{"readyReplicas": c.ready, "availableReplicas": c.available}}}
		ds := &unstructured.Unstructured{Object: map[string]interface{}{"metadata": meta, "spec": map[string]interface{}{},
			"status": map[string]interface{}{"desiredNumberScheduled": c.desired, "numberReady": c.ready, "numberAvailable": c.available}}}
		rs := &unstructured.Unstructured{Object: map[string]interface{}{"metadata": meta,
			"spec":   map[string]interface{}{"replicas": c.desired},
			"status": map[string]interface{}{"readyReplicas": c.ready, "availableReplicas": c.available}}}
		for kind, got := range map[string]interface{}{
			"StatefulSet": statefulsetToInfo(sts)["status"],
			"DaemonSet":   daemonsetToInfo(ds)["status"],
			"ReplicaSet":  replicasetToInfo(rs)["status"],
		} {
			if got != c.want {
				t.Errorf("%s %s (%d wanted, %d ready, %d available): status %v, want %s", kind, c.name, c.desired, c.ready, c.available, got, c.want)
			}
		}
	}
}
