package k8s

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	fakediscovery "k8s.io/client-go/discovery/fake"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func withMeta(o *unstructured.Unstructured, uid, rv string, gen int64, finalizers []string) *unstructured.Unstructured {
	o.SetUID(types.UID(uid))
	o.SetResourceVersion(rv)
	o.SetGeneration(gen)
	if len(finalizers) > 0 {
		o.SetFinalizers(finalizers)
	}
	return o
}

// A cluster serving Gateway API: gatewayclasses (cluster-scoped, v1) and
// referencegrants (namespaced, v1beta1), one object each.
func newGatewayDescribeService(t *testing.T) *Service {
	t.Helper()
	fakeCS := fake.NewSimpleClientset()
	disc := fakeCS.Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "gatewayclasses", Kind: "GatewayClass", Namespaced: false},
			{Name: "gateways", Kind: "Gateway", Namespaced: true},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1beta1", APIResources: []metav1.APIResource{
			{Name: "referencegrants", Kind: "ReferenceGrant", Namespaced: true},
		}},
	}

	gc := withMeta(obj("gateway.networking.k8s.io/v1", "GatewayClass", "", "envoy", map[string]interface{}{
		"controllerName": "gateway.envoyproxy.io/gatewayclass-controller",
	}, nil), "11111111-aaaa-4bbb-8ccc-000000000001", "4242", 3, []string{"gateway-exists-finalizer.gateway.networking.k8s.io"})
	rg := withMeta(obj("gateway.networking.k8s.io/v1beta1", "ReferenceGrant", "web", "allow-gw", map[string]interface{}{
		"from": []interface{}{map[string]interface{}{"group": "gateway.networking.k8s.io", "kind": "Gateway", "namespace": "infra"}},
		"to":   []interface{}{map[string]interface{}{"group": "", "kind": "Service"}},
	}, nil), "22222222-aaaa-4bbb-8ccc-000000000002", "77", 1, nil)

	scheme := runtime.NewScheme()
	dyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		{Group: gatewayAPIGroup, Version: "v1", Resource: "gatewayclasses"}:       "GatewayClassList",
		{Group: gatewayAPIGroup, Version: "v1beta1", Resource: "referencegrants"}: "ReferenceGrantList",
	}, gc, rg)
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{dynamic: dyn, discovery: disc})
	return s
}

func TestDescribeGatewayClass_CarriesObjectMeta(t *testing.T) {
	s := newGatewayDescribeService(t)
	out, err := s.DescribeGatewayClass(context.Background(), "envoy")
	if err != nil {
		t.Fatalf("DescribeGatewayClass: %v", err)
	}
	if out["uid"] != "11111111-aaaa-4bbb-8ccc-000000000001" {
		t.Errorf("uid = %v", out["uid"])
	}
	if out["resource_version"] != "4242" {
		t.Errorf("resource_version = %v", out["resource_version"])
	}
	if out["generation"] != int64(3) {
		t.Errorf("generation = %v (%T)", out["generation"], out["generation"])
	}
	fin, _ := out["finalizers"].([]string)
	if len(fin) != 1 || fin[0] != "gateway-exists-finalizer.gateway.networking.k8s.io" {
		t.Errorf("finalizers = %v", out["finalizers"])
	}
	if out["controller_name"] != "gateway.envoyproxy.io/gatewayclass-controller" {
		t.Errorf("controller_name = %v", out["controller_name"])
	}
}

func TestDescribeReferenceGrant_CarriesObjectMeta(t *testing.T) {
	s := newGatewayDescribeService(t)
	out, err := s.DescribeReferenceGrant(context.Background(), "web", "allow-gw")
	if err != nil {
		t.Fatalf("DescribeReferenceGrant: %v", err)
	}
	if out["uid"] != "22222222-aaaa-4bbb-8ccc-000000000002" || out["resource_version"] != "77" || out["generation"] != int64(1) {
		t.Errorf("metadata = uid %v rv %v gen %v", out["uid"], out["resource_version"], out["generation"])
	}
	if _, has := out["finalizers"]; has {
		t.Errorf("finalizers present on an object without any: %v", out["finalizers"])
	}
	if out["namespace"] != "web" || out["name"] != "allow-gw" {
		t.Errorf("identity = %v/%v", out["namespace"], out["name"])
	}
}
