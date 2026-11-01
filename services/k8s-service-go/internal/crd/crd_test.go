package crd

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// As kubectl's VERSIONS column: the served versions, sorted, a version the API does not serve left out; version stays
// the storage version the instance pages ask for.
func TestInfo(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   map[string]interface{}{"name": "gateways.gateway.networking.k8s.io", "creationTimestamp": "2026-11-01T03:04:05Z"},
		"spec": map[string]interface{}{
			"group": "gateway.networking.k8s.io",
			"scope": "Namespaced",
			"names": map[string]interface{}{"kind": "Gateway", "plural": "gateways"},
			"versions": []interface{}{
				map[string]interface{}{"name": "v1beta1", "served": true, "storage": false},
				map[string]interface{}{"name": "v1alpha2", "served": false, "storage": false},
				map[string]interface{}{"name": "v1", "served": true, "storage": true},
			},
		},
	}}
	row := Info(u)
	if !reflect.DeepEqual(row["served_versions"], []string{"v1", "v1beta1"}) {
		t.Errorf("served_versions = %v", row["served_versions"])
	}
	for k, want := range map[string]interface{}{
		"name": "gateways.gateway.networking.k8s.io", "group": "gateway.networking.k8s.io", "version": "v1",
		"scope": "Namespaced", "kind": "Gateway", "created_at": "2026-11-01T03:04:05Z",
	} {
		if row[k] != want {
			t.Errorf("%s = %v, want %v", k, row[k], want)
		}
	}
}
