package gatewayrow

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func obj(kind string, spec, status map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       kind,
		"metadata": map[string]interface{}{
			"name": "one", "namespace": "shop", "creationTimestamp": "2026-11-01T03:04:05Z",
			"annotations": map[string]interface{}{"team": "web"},
		},
		"spec":   spec,
		"status": status,
	}}
}

func cond(kind, status string) interface{} {
	return map[string]interface{}{"type": kind, "status": status, "reason": kind}
}

// The condition summary the list pages show: the named conditions first, then the first that holds, then the first
// that does not as "<type>(False)", else "Unknown".
func TestSummary(t *testing.T) {
	c := func(l ...interface{}) []map[string]interface{} { return maps(l) }
	for _, tc := range []struct {
		conds []map[string]interface{}
		first []string
		want  string
	}{
		{c(cond("Accepted", "True"), cond("Programmed", "True")), []string{"Programmed", "Accepted"}, "Programmed"},
		{c(cond("Programmed", "False"), cond("Accepted", "True")), []string{"Programmed", "Accepted"}, "Accepted"},
		{c(cond("Ready", "True")), []string{"Accepted"}, "Ready"},
		{c(cond("Accepted", "False"), cond("Ready", "Unknown")), []string{"Accepted"}, "Accepted(False)"},
		{c(), []string{"Accepted"}, "Unknown"},
	} {
		if got := summary(tc.conds, tc.first...); got != tc.want {
			t.Errorf("%v: %q, want %q", tc.conds, got, tc.want)
		}
	}
}

func TestGateway(t *testing.T) {
	g := Gateway(obj("Gateway",
		map[string]interface{}{"gatewayClassName": "eg", "listeners": []interface{}{
			map[string]interface{}{"name": "http", "port": int64(80)}, map[string]interface{}{"name": "https", "port": int64(443)},
		}},
		map[string]interface{}{
			"conditions": []interface{}{cond("Accepted", "True"), cond("Programmed", "True")},
			"listeners":  []interface{}{map[string]interface{}{"name": "http", "attachedRoutes": int64(2)}, map[string]interface{}{"name": "https", "attachedRoutes": int64(1)}},
			"addresses":  []interface{}{map[string]interface{}{"type": "IPAddress", "value": "10.0.0.7"}},
		}))
	for k, want := range map[string]interface{}{
		"name": "one", "namespace": "shop", "gateway_class_name": "eg", "listeners_count": 2, "attached_routes": int64(3),
		"addresses_count": 1, "status": "Programmed", "programmed": true, "accepted": true, "created_at": "2026-11-01T03:04:05Z",
		"api_version": "gateway.networking.k8s.io/v1",
	} {
		if !reflect.DeepEqual(g[k], want) {
			t.Errorf("%s = %#v, want %#v", k, g[k], want)
		}
	}
	if g["annotations"].(map[string]string)["team"] != "web" {
		t.Errorf("annotations: %v", g["annotations"])
	}
}

func TestGatewayClass(t *testing.T) {
	c := GatewayClass(obj("GatewayClass",
		map[string]interface{}{"controllerName": "example.com/gw", "description": "edge", "parametersRef": map[string]interface{}{"group": "example.com", "kind": "Config", "name": "p"}},
		map[string]interface{}{"conditions": []interface{}{cond("Accepted", "False")}}))
	if c["controller_name"] != "example.com/gw" || c["description"] != "edge" || c["accepted"] != false || c["status"] != "Accepted(False)" || c["parameters_ref"] == nil {
		t.Fatalf("class row: %v", c)
	}
	if none := GatewayClass(obj("GatewayClass", map[string]interface{}{"controllerName": "x"}, nil)); none["parameters_ref"] != nil || none["status"] != "Unknown" {
		t.Fatalf("class without parameters or status: %v", none)
	}
}

// A route's conditions are pooled over every parent it reports on: accepted and resolved refs hold when one does.
func TestRoute(t *testing.T) {
	r := Route(obj("HTTPRoute",
		map[string]interface{}{
			"hostnames":  []interface{}{"shop.example.com"},
			"parentRefs": []interface{}{map[string]interface{}{"name": "gw-a"}, map[string]interface{}{"name": "gw-b"}},
			"rules": []interface{}{
				map[string]interface{}{"backendRefs": []interface{}{map[string]interface{}{"name": "web"}, map[string]interface{}{"name": "web-canary"}}},
				map[string]interface{}{"backendRefs": []interface{}{map[string]interface{}{"name": "api"}}},
			},
		},
		map[string]interface{}{"parents": []interface{}{
			map[string]interface{}{"parentRef": map[string]interface{}{"name": "gw-a"}, "conditions": []interface{}{cond("Accepted", "False")}},
			map[string]interface{}{"parentRef": map[string]interface{}{"name": "gw-b"}, "conditions": []interface{}{cond("Accepted", "True"), cond("ResolvedRefs", "True")}},
		}}))
	for k, want := range map[string]interface{}{
		"rule_count": 2, "parent_refs_count": 2, "backend_refs_count": 3, "accepted": true, "resolved_refs": true, "status": "Accepted",
		"hostnames": []string{"shop.example.com"},
	} {
		if !reflect.DeepEqual(r[k], want) {
			t.Errorf("%s = %#v, want %#v", k, r[k], want)
		}
	}
	if n := len(r["conditions"].([]map[string]interface{})); n != 3 {
		t.Errorf("pooled conditions: %d", n)
	}
}

func TestReferenceGrantAndPolicy(t *testing.T) {
	g := ReferenceGrant(obj("ReferenceGrant", map[string]interface{}{
		"from": []interface{}{map[string]interface{}{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "namespace": "web"}},
		"to":   []interface{}{map[string]interface{}{"group": "", "kind": "Service", "name": "api"}},
	}, nil))
	if !reflect.DeepEqual(g["from"], []map[string]interface{}{{"group": "gateway.networking.k8s.io", "kind": "HTTPRoute", "namespace": "web"}}) ||
		!reflect.DeepEqual(g["to"], []map[string]interface{}{{"group": "", "kind": "Service", "name": "api"}}) {
		t.Fatalf("grant: %v %v", g["from"], g["to"])
	}
	p := Policy(obj("BackendTLSPolicy",
		map[string]interface{}{"targetRefs": []interface{}{map[string]interface{}{"group": "", "kind": "Service", "name": "api", "sectionName": "https"}}},
		map[string]interface{}{"ancestors": []interface{}{
			map[string]interface{}{"ancestorRef": map[string]interface{}{"name": "gw-a"}},
			map[string]interface{}{"ancestorRef": map[string]interface{}{"name": "gw-b"}, "conditions": []interface{}{cond("Accepted", "True")}},
		}}))
	refs := p["target_refs"].([]map[string]interface{})
	if len(refs) != 1 || refs[0]["kind"] != "Service" || refs[0]["sectionName"] != "https" {
		t.Fatalf("targets: %v", refs)
	}
	if conds := p["conditions"].([]map[string]interface{}); len(conds) != 1 || conds[0]["type"] != "Accepted" {
		t.Fatalf("first ancestor with conditions: %v", conds)
	}
	single := Policy(obj("BackendTLSPolicy", map[string]interface{}{"targetRef": map[string]interface{}{"kind": "Service", "name": "old"}}, nil))
	if refs := single["target_refs"].([]map[string]interface{}); len(refs) != 1 || refs[0]["name"] != "old" {
		t.Fatalf("spec.targetRef: %v", refs)
	}
}
