package ws

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Re-QA #59: a watch event carried container state as a string ("Error")
// while the list carries {terminated: {reason: ...}}, so a row updated by the
// watch fell back to the phase (Failed) — the same pod read Error elsewhere.
func TestPodInfoContainerStateMatchesTheList(t *testing.T) {
	pod := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "job-x", "namespace": "a"},
		"spec":     map[string]interface{}{"containers": []interface{}{map[string]interface{}{"name": "main", "image": "busybox"}}},
		"status": map[string]interface{}{
			"phase": "Failed",
			"containerStatuses": []interface{}{map[string]interface{}{
				"name":      "main",
				"state":     map[string]interface{}{"terminated": map[string]interface{}{"reason": "Error", "exitCode": int64(1), "startedAt": "2026-10-07T08:47:42Z", "finishedAt": "2026-10-07T08:47:43Z"}},
				"lastState": map[string]interface{}{},
			}},
		},
	}}
	info := objectToInfo("pods", pod)
	if info["status"] != "Error" {
		t.Errorf("status = %v, want Error", info["status"])
	}
	c := info["containers"].([]map[string]interface{})[0]
	want := map[string]interface{}{"terminated": map[string]interface{}{
		"exit_code": int64(1), "reason": "Error", "message": "",
		"started_at": "2026-10-07T08:47:42Z", "finished_at": "2026-10-07T08:47:43Z",
	}}
	if !reflect.DeepEqual(c["state"], want) {
		t.Errorf("state = %#v", c["state"])
	}
	if !reflect.DeepEqual(c["last_state"], map[string]interface{}{}) {
		t.Errorf("last_state = %#v, want empty", c["last_state"])
	}
}

// Re-QA #30 / #33 on the watch path: the same keys as the list endpoint.
func TestWorkloadInfoCurrentAndScalingActive(t *testing.T) {
	rs := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "web-1", "namespace": "a"},
		"spec":     map[string]interface{}{"replicas": int64(3)},
		"status":   map[string]interface{}{"replicas": int64(2), "readyReplicas": int64(1)},
	}}
	if got := objectToInfo("replicasets", rs)["current_replicas"]; got != int64(2) {
		t.Errorf("replicaset current_replicas = %v, want 2", got)
	}

	hpa := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "web", "namespace": "a"},
		"spec":     map[string]interface{}{"maxReplicas": int64(3)},
		"status": map[string]interface{}{"currentReplicas": int64(1), "conditions": []interface{}{
			map[string]interface{}{"type": "AbleToScale", "status": "True"},
			map[string]interface{}{"type": "ScalingActive", "status": "False", "reason": "FailedGetResourceMetric"},
		}},
	}}
	if got := objectToInfo("horizontalpodautoscalers", hpa)["scaling_active"]; got != false {
		t.Errorf("hpa scaling_active = %v, want false", got)
	}
}
