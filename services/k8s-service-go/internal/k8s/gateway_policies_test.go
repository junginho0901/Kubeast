package k8s

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func obj(apiVersion, kind, ns, name string, spec, status map[string]interface{}) *unstructured.Unstructured {
	o := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": apiVersion, "kind": kind,
		"metadata": map[string]interface{}{"name": name},
	}}
	if ns != "" {
		o.SetNamespace(ns)
	}
	if spec != nil {
		o.Object["spec"] = spec
	}
	if status != nil {
		o.Object["status"] = status
	}
	return o
}

// A cluster with NGINX Gateway Fabric (labelled CRD), Istio and Envoy Gateway
// (unlabelled, built-in table) policies, plus an unrelated CRD without the label.
func newPolicyService(t *testing.T) *Service {
	t.Helper()
	fakeCS := fake.NewSimpleClientset()
	disc := fakeCS.Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.nginx.org/v1alpha1", APIResources: []metav1.APIResource{{Name: "clientsettingspolicies", Kind: "ClientSettingsPolicy", Namespaced: true}}},
		{GroupVersion: "security.istio.io/v1", APIResources: []metav1.APIResource{{Name: "authorizationpolicies", Kind: "AuthorizationPolicy", Namespaced: true}}},
		{GroupVersion: "networking.istio.io/v1", APIResources: []metav1.APIResource{{Name: "destinationrules", Kind: "DestinationRule", Namespaced: true}}},
		{GroupVersion: "gateway.envoyproxy.io/v1alpha1", APIResources: []metav1.APIResource{{Name: "backendtrafficpolicies", Kind: "BackendTrafficPolicy", Namespaced: true}}},
	}

	crd := func(group, plural, kind, scope, version string, labels map[string]interface{}) *unstructured.Unstructured {
		o := obj("apiextensions.k8s.io/v1", "CustomResourceDefinition", "", plural+"."+group, map[string]interface{}{
			"group": group, "scope": scope,
			"names":    map[string]interface{}{"plural": plural, "kind": kind},
			"versions": []interface{}{map[string]interface{}{"name": version, "served": true, "storage": true}},
		}, nil)
		if labels != nil {
			o.Object["metadata"].(map[string]interface{})["labels"] = labels
		}
		return o
	}
	policyLabel := map[string]interface{}{gatewayPolicyLabel: "inherited"}
	objects := []runtime.Object{
		crd("gateway.nginx.org", "clientsettingspolicies", "ClientSettingsPolicy", "Namespaced", "v1alpha1", policyLabel),
		crd("qa.example.com", "widgets", "Widget", "Namespaced", "v1", nil),
		obj("gateway.nginx.org/v1alpha1", "ClientSettingsPolicy", "web", "csp", map[string]interface{}{
			"targetRef": map[string]interface{}{"group": "gateway.networking.k8s.io", "kind": "Gateway", "name": "gw"},
		}, map[string]interface{}{
			"ancestors": []interface{}{map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}}}},
		}),
		obj("security.istio.io/v1", "AuthorizationPolicy", "web", "allow-gw", map[string]interface{}{
			"targetRefs": []interface{}{map[string]interface{}{"kind": "Gateway", "group": "gateway.networking.k8s.io", "name": "gw"}},
		}, nil),
		obj("security.istio.io/v1", "AuthorizationPolicy", "other", "by-selector", map[string]interface{}{
			"selector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "web", "tier": "front"}},
		}, nil),
		obj("networking.istio.io/v1", "DestinationRule", "web", "web-dr", map[string]interface{}{"host": "web.web.svc.cluster.local"}, nil),
		obj("gateway.envoyproxy.io/v1alpha1", "BackendTrafficPolicy", "web", "retries", map[string]interface{}{
			"targetRefs": []interface{}{map[string]interface{}{"kind": "HTTPRoute", "name": "r1"}},
		}, map[string]interface{}{
			"ancestors": []interface{}{
				map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "True"}}},
				map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Accepted", "status": "False"}}},
			},
		}),
	}
	scheme := runtime.NewScheme()
	dyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		crdGVR: "CustomResourceDefinitionList",
		{Group: "gateway.nginx.org", Version: "v1alpha1", Resource: "clientsettingspolicies"}:     "ClientSettingsPolicyList",
		{Group: "security.istio.io", Version: "v1", Resource: "authorizationpolicies"}:            "AuthorizationPolicyList",
		{Group: "networking.istio.io", Version: "v1", Resource: "destinationrules"}:               "DestinationRuleList",
		{Group: "gateway.envoyproxy.io", Version: "v1alpha1", Resource: "backendtrafficpolicies"}: "BackendTrafficPolicyList",
	}, objects...)
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{dynamic: dyn, discovery: disc})
	return s
}

func TestGetGatewayPolicies_AllKindsOnePage(t *testing.T) {
	s := newPolicyService(t)
	out, err := s.GetGatewayPolicies(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("GetGatewayPolicies: %v", err)
	}
	kinds := out["kinds"].([]map[string]interface{})
	sources := map[string]string{}
	for _, k := range kinds {
		sources[k["kind"].(string)] = k["source"].(string)
		if _, bad := k["error"]; bad {
			t.Errorf("kind %s reported error %v", k["kind"], k["error"])
		}
	}
	for kind, want := range map[string]string{
		"ClientSettingsPolicy": "label",   // labelled CRD, no table entry needed
		"AuthorizationPolicy":  "builtin", // Istio, unlabelled
		"DestinationRule":      "builtin",
		"BackendTrafficPolicy": "builtin", // Envoy Gateway, unlabelled
	} {
		if sources[kind] != want {
			t.Errorf("kind %s source = %q, want %q (kinds=%v)", kind, sources[kind], want, sources)
		}
	}
	if _, present := sources["Widget"]; present {
		t.Error("a CRD without the policy label must not be listed")
	}

	items := out["items"].([]map[string]interface{})
	byName := map[string]map[string]interface{}{}
	for _, it := range items {
		byName[it["name"].(string)] = it
	}
	if len(items) != 5 {
		t.Fatalf("items = %d, want 5: %v", len(items), byName)
	}
	targets := func(name string) []map[string]interface{} { return byName[name]["targets"].([]map[string]interface{}) }
	if tg := targets("csp"); len(tg) != 1 || tg[0]["kind"] != "Gateway" || tg[0]["name"] != "gw" {
		t.Errorf("targetRef target = %v", tg)
	}
	if tg := targets("by-selector"); len(tg) != 1 || tg[0]["kind"] != "selector" || tg[0]["name"] != "app=web,tier=front" {
		t.Errorf("selector target = %v", tg)
	}
	if tg := targets("web-dr"); len(tg) != 1 || tg[0]["kind"] != "host" || tg[0]["name"] != "web.web.svc.cluster.local" {
		t.Errorf("host target = %v", tg)
	}
	if acc, ok := byName["csp"]["accepted"]; !ok || acc != true {
		t.Errorf("csp accepted = %v (present=%v), want true", acc, ok)
	}
	if acc, ok := byName["retries"]["accepted"]; !ok || acc != false {
		t.Errorf("retries accepted = %v (present=%v), want false (one ancestor rejected)", acc, ok)
	}
	if _, ok := byName["allow-gw"]["accepted"]; ok {
		t.Error("no Accepted condition → the field must be absent, not false")
	}
}

func TestGetGatewayPolicies_NamespaceAndConfiguredKinds(t *testing.T) {
	s := newPolicyService(t)
	out, err := s.GetGatewayPolicies(context.Background(), "web", []string{"gateway.kgateway.dev/trafficpolicies", "not-a-pair"})
	if err != nil {
		t.Fatalf("GetGatewayPolicies: %v", err)
	}
	for _, it := range out["items"].([]map[string]interface{}) {
		if it["namespace"] != "web" {
			t.Errorf("namespace filter leaked %s/%s", it["namespace"], it["name"])
		}
	}
	for _, k := range out["kinds"].([]map[string]interface{}) {
		if k["group"] == "gateway.kgateway.dev" {
			t.Error("a configured kind the cluster does not serve must be skipped")
		}
	}
}
