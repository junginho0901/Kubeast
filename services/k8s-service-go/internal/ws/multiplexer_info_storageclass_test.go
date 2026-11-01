package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// A live update of a class is the list's row: the beta default annotation counts, as kubectl reads it.
func TestObjectToInfoStorageClassIsTheListRow(t *testing.T) {
	class := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "storage.k8s.io/v1",
		"kind":       "StorageClass",
		"metadata": map[string]interface{}{
			"name":              "old",
			"creationTimestamp": "2026-11-01T03:04:05Z",
			"annotations":       map[string]interface{}{"storageclass.beta.kubernetes.io/is-default-class": "true"},
		},
		"provisioner":          "example.com/disk",
		"allowVolumeExpansion": true,
		"parameters":           map[string]interface{}{"type": "ssd"},
	}}
	info := objectToInfo("storageclasses", class)
	if info["is_default"] != true || info["provisioner"] != "example.com/disk" || info["allow_volume_expansion"] != true {
		t.Fatalf("class row: %v", info)
	}
	if params, ok := info["parameters"].(map[string]string); !ok || params["type"] != "ssd" {
		t.Fatalf("parameters: %#v", info["parameters"])
	}
	if info["created_at"] != "2026-11-01T03:04:05Z" {
		t.Fatalf("created_at: %v", info["created_at"])
	}
}
