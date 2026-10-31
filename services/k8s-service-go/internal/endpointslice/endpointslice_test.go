package endpointslice

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The row has every field of the slice the list, its drawer and the live updates show: endpoints with their
// conditions, node, zone, Pod and hints, ports once each with the app protocol, labels and annotations.
func TestInfo(t *testing.T) {
	yes, no := true, false
	host, node, zone := "web-0", "node-a", "zone-a"
	name, port, tcp, h2c := "http", int32(8080), corev1.ProtocolTCP, "kubernetes.io/h2c"
	es := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name: "web-abc", Namespace: "qa",
			CreationTimestamp: metav1.Date(2026, 11, 1, 3, 4, 5, 0, metav1.Now().Location()),
			Labels:            map[string]string{discoveryv1.LabelServiceName: "web", discoveryv1.LabelManagedBy: "endpointslice-controller.k8s.io"},
			Annotations:       map[string]string{"note": "kept"},
		},
		AddressType: discoveryv1.AddressTypeIPv4,
		Ports: []discoveryv1.EndpointPort{
			{Name: &name, Port: &port, Protocol: &tcp, AppProtocol: &h2c},
			{Name: &name, Port: &port, Protocol: &tcp, AppProtocol: &h2c},
		},
		Endpoints: []discoveryv1.Endpoint{
			{
				Addresses:  []string{"10.0.0.1"},
				Conditions: discoveryv1.EndpointConditions{Ready: &yes, Serving: &yes, Terminating: &no},
				Hostname:   &host, NodeName: &node, Zone: &zone,
				TargetRef: &corev1.ObjectReference{Kind: "Pod", Name: "web-0", Namespace: "qa"},
				Hints:     &discoveryv1.EndpointHints{ForZones: []discoveryv1.ForZone{{Name: "zone-a"}, {Name: "zone-b"}}, ForNodes: []discoveryv1.ForNode{{Name: "node-a"}}},
			},
			{Addresses: []string{"10.0.0.2"}, Conditions: discoveryv1.EndpointConditions{Ready: &no}},
			{Addresses: []string{"10.0.0.3"}},
		},
	}

	got := Info(es)
	want := map[string]interface{}{
		"name": "web-abc", "namespace": "qa", "service_name": "web", "managed_by": "endpointslice-controller.k8s.io",
		"address_type": "IPv4", "endpoints_total": 3, "endpoints_ready": 2, "endpoints_not_ready": 1,
		"endpoints": []map[string]interface{}{
			{
				"addresses":  []string{"10.0.0.1"},
				"conditions": map[string]interface{}{"ready": true, "serving": true, "terminating": false},
				"hostname":   "web-0", "node_name": "node-a", "zone": "zone-a",
				"target_ref": map[string]interface{}{"kind": "Pod", "name": "web-0", "namespace": "qa"},
				"hints":      map[string]interface{}{"for_zones": []string{"zone-a", "zone-b"}, "for_nodes": []string{"node-a"}},
			},
			{"addresses": []string{"10.0.0.2"}, "conditions": map[string]interface{}{"ready": false}},
			{"addresses": []string{"10.0.0.3"}, "conditions": map[string]interface{}{}},
		},
		"ports":       []map[string]interface{}{{"name": "http", "port": int32(8080), "protocol": "TCP", "app_protocol": "kubernetes.io/h2c"}},
		"labels":      es.Labels,
		"annotations": es.Annotations,
		"created_at":  es.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
	for k, v := range want {
		if !reflect.DeepEqual(got[k], v) {
			t.Errorf("%s = %#v, want %#v", k, got[k], v)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected key %s", k)
		}
	}
}
