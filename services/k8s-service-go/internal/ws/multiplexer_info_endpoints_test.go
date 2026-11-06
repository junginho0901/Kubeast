package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Endpoints / EndpointSlice carry their payload at the top level, not under spec or status; a live update of either is
// the list's row, so the counts, addresses, labels and annotations come from it.
func TestObjectToInfoEndpointsReadsTopLevelPayload(t *testing.T) {
	ep := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Endpoints",
		"metadata": map[string]interface{}{"name": "web", "namespace": "qa"},
		"subsets": []interface{}{map[string]interface{}{
			"addresses": []interface{}{map[string]interface{}{"ip": "10.0.0.1"}},
			"ports":     []interface{}{map[string]interface{}{"port": int64(80), "protocol": "TCP"}},
		}},
	}}
	info := objectToInfo("endpoints", ep)
	if info["ready_count"] != 1 || info["not_ready_count"] != 0 {
		t.Fatalf("endpoints counts: %v", info)
	}
	if got := info["ready_addresses"].([]string); len(got) != 1 || got[0] != "10.0.0.1" {
		t.Fatalf("endpoints addresses: %v", info["ready_addresses"])
	}

	slice := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind": "EndpointSlice",
		"metadata": map[string]interface{}{
			"name": "web-abc", "namespace": "qa",
			"labels":      map[string]interface{}{"kubernetes.io/service-name": "web"},
			"annotations": map[string]interface{}{"note": "kept"},
		},
		"addressType": "IPv4",
		"endpoints":   []interface{}{map[string]interface{}{"addresses": []interface{}{"10.0.0.1"}, "conditions": map[string]interface{}{"ready": true}}},
		"ports":       []interface{}{map[string]interface{}{"port": int64(80)}},
	}}
	info = objectToInfo("endpointslices", slice)
	if info["address_type"] != "IPv4" || info["service_name"] != "web" || info["endpoints_ready"] != 1 {
		t.Fatalf("endpointslice row: %v", info)
	}
	if eps := info["endpoints"].([]map[string]interface{}); len(eps) != 1 || eps[0]["addresses"].([]string)[0] != "10.0.0.1" {
		t.Fatalf("endpointslice endpoints: %v", info["endpoints"])
	}
	if info["annotations"].(map[string]string)["note"] != "kept" {
		t.Fatalf("endpointslice annotations: %v", info["annotations"])
	}
}
