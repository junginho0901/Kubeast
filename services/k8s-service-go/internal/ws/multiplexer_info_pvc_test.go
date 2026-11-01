package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// A live update of a claim is the list's row: a claim not bound yet shows no access modes (kubectl prints none), and
// the modes it asks for come as requested_access_modes.
func TestObjectToInfoPVCIsTheListRow(t *testing.T) {
	claim := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "PersistentVolumeClaim",
		"metadata": map[string]interface{}{"name": "data", "namespace": "qa", "creationTimestamp": "2026-11-01T03:04:05Z"},
		"spec": map[string]interface{}{
			"accessModes": []interface{}{"ReadWriteOnce"},
			"resources":   map[string]interface{}{"requests": map[string]interface{}{"storage": "1Gi"}},
		},
		"status": map[string]interface{}{"phase": "Pending"},
	}}
	info := objectToInfo("persistentvolumeclaims", claim)
	if modes := info["access_modes"].([]string); len(modes) != 0 {
		t.Fatalf("access modes of a claim not bound: %v", modes)
	}
	if req := info["requested_access_modes"].([]string); len(req) != 1 || req[0] != "ReadWriteOnce" {
		t.Fatalf("requested access modes: %v", req)
	}
	if info["requested"] != "1Gi" || info["status"] != "Pending" || info["created_at"] != "2026-11-01T03:04:05Z" {
		t.Fatalf("claim row: %v", info)
	}
}
