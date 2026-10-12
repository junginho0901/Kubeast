package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Two slices of one Service: ready, unset (= ready) and not-ready endpoints
// are counted and flattened with the slice's ports and the Pod reference.
func TestEndpointSlices_ReadyAndFlatten(t *testing.T) {
	yes, no := true, false
	name, port, tcp := "http", int32(8080), corev1.ProtocolTCP
	slices := []discoveryv1.EndpointSlice{
		{
			ObjectMeta: metav1.ObjectMeta{Namespace: "web", Name: "api-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
			Ports:      []discoveryv1.EndpointPort{{Name: &name, Port: &port, Protocol: &tcp}},
			Endpoints: []discoveryv1.Endpoint{
				{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: &yes}, TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "api-1", Namespace: "web"}},
				{Addresses: []string{"10.0.0.2", "10.0.0.3"}, Conditions: discoveryv1.EndpointConditions{Ready: &no}},
			},
		},
		{
			ObjectMeta: metav1.ObjectMeta{Namespace: "web", Name: "api-def", Labels: map[string]string{discoveryv1.LabelServiceName: "api"}},
			Endpoints:  []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.4"}}},
		},
	}

	ready, notReady := readyAddresses(slices)
	if len(ready) != 2 || ready[0] != "10.0.0.1" || ready[1] != "10.0.0.4" {
		t.Fatalf("ready = %v", ready)
	}
	if len(notReady) != 2 || notReady[0] != "10.0.0.2" {
		t.Fatalf("not ready = %v", notReady)
	}

	flat := sliceAddresses(slices)
	if len(flat) != 4 {
		t.Fatalf("flattened %d addresses: %v", len(flat), flat)
	}
	first := flat[0]
	if first["ip"] != "10.0.0.1" || first["ready"] != true || first["target_ref"].(map[string]interface{})["name"] != "api-1" {
		t.Fatalf("first = %v", first)
	}
	ports := first["ports"].([]map[string]interface{})
	if len(ports) != 1 || ports[0]["name"] != "http" || ports[0]["port"] != int32(8080) || ports[0]["protocol"] != "TCP" {
		t.Fatalf("ports = %v", ports)
	}
	if flat[1]["ready"] != false || flat[3]["ready"] != true || len(flat[3]["ports"].([]map[string]interface{})) != 0 {
		t.Fatalf("ready flags / ports: %v %v", flat[1], flat[3])
	}
	if _, has := flat[1]["target_ref"]; has {
		t.Fatalf("no target_ref expected: %v", flat[1])
	}
}
