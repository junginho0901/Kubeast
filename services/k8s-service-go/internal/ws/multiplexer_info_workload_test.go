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

// A watch event's Deployment status and reason are the list's (deploystatus.Of): a rollout past its progress deadline
// is Failed with the reason even while Available=True comes first, as the controller writes them.
func TestDeploymentToInfo_StatusAsTheList(t *testing.T) {
	cond := func(typ, status, reason string) interface{} {
		return map[string]interface{}{"type": typ, "status": status, "reason": reason}
	}
	for _, c := range []struct {
		name           string
		conds          []interface{}
		status, reason string
	}{
		{"stuck rollout, old pods available", []interface{}{cond("Available", "True", "MinimumReplicasAvailable"), cond("Progressing", "False", "ProgressDeadlineExceeded")}, "Failed", "ProgressDeadlineExceeded"},
		{"rolled out", []interface{}{cond("Available", "True", "MinimumReplicasAvailable"), cond("Progressing", "True", "NewReplicaSetAvailable")}, "Available", ""},
		{"starting", []interface{}{cond("Available", "False", "MinimumReplicasUnavailable"), cond("Progressing", "True", "ReplicaSetUpdated")}, "Progressing", ""},
	} {
		obj := &unstructured.Unstructured{Object: map[string]interface{}{
			"metadata": map[string]interface{}{"name": "d", "namespace": "ns"},
			"spec":     map[string]interface{}{"replicas": int64(1)},
			"status":   map[string]interface{}{"availableReplicas": int64(1), "unavailableReplicas": int64(1), "conditions": c.conds},
		}}
		info := deploymentToInfo(obj)
		if info["status"] != c.status || info["progressing_reason"] != c.reason || info["unavailable_replicas"] != int32(1) {
			t.Errorf("%s: status %v reason %v unavailable %v, want %q %q 1", c.name, info["status"], info["progressing_reason"], info["unavailable_replicas"], c.status, c.reason)
		}
	}
}
