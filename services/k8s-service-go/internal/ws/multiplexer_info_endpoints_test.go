package ws

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Endpoints / EndpointSlice carry their payload at the top level; the watch
// summary has to pass it through or the list resets ready counts to 0.
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
		"kind":        "EndpointSlice",
		"metadata":    map[string]interface{}{"name": "web-abc", "namespace": "qa"},
		"addressType": "IPv4",
		"endpoints":   []interface{}{map[string]interface{}{"addresses": []interface{}{"10.0.0.1"}, "conditions": map[string]interface{}{"ready": true}}},
		"ports":       []interface{}{map[string]interface{}{"port": int64(80)}},
	}}
	info = objectToInfo("endpointslices", slice)
	for _, key := range []string{"addressType", "endpoints", "ports"} {
		if _, ok := info[key]; !ok {
			t.Fatalf("endpointslice info lost %s: %v", key, info)
		}
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
