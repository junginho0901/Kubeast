package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Endpoints / EndpointSlice carry their payload at the top level; the watch
// summary has to keep it or the list resets ready counts to 0. An EndpointSlice
// update is the list's row, labels and annotations included.
func TestObjectToInfoEndpointsKeepsTopLevelPayload(t *testing.T) {
	ep := &unstructured.Unstructured{Object: map[string]interface{}{
		"kind":     "Endpoints",
		"metadata": map[string]interface{}{"name": "web", "namespace": "qa"},
		"subsets": []interface{}{map[string]interface{}{
			"addresses": []interface{}{map[string]interface{}{"ip": "10.0.0.1"}},
			"ports":     []interface{}{map[string]interface{}{"port": int64(80), "protocol": "TCP"}},
		}},
	}}
	info := objectToInfo("endpoints", ep)
	if _, ok := info["subsets"]; !ok {
		t.Fatalf("endpoints info lost subsets: %v", info)
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

func TestContainerNamesFromTemplate(t *testing.T) {
	spec := map[string]interface{}{"template": map[string]interface{}{"spec": map[string]interface{}{
		"containers": []interface{}{
			map[string]interface{}{"name": "app", "image": "nginx:1"},
			map[string]interface{}{"name": "sidecar", "image": "busybox"},
		},
	}}}
	got := containerNamesFromTemplate(spec)
	if len(got) != 2 || got[0] != "app" || got[1] != "sidecar" {
		t.Fatalf("containerNamesFromTemplate = %v", got)
	}
	if got := containerNamesFromTemplate(nil); len(got) != 0 {
		t.Fatalf("nil spec should give no names, got %v", got)
	}
}
