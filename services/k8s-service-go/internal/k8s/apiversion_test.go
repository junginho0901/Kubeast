package k8s

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"
)

// A cluster like kind 1.37 with Gateway API 1.3 experimental installed: the
// gateway group mixes versions per kind and resource.k8s.io is served as v1 only.
func newDiscoveryService(t *testing.T) *Service {
	t.Helper()
	fakeCS := fake.NewSimpleClientset()
	disc := fakeCS.Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "gateways", Kind: "Gateway", Namespaced: true},
			{Name: "gatewayclasses", Kind: "GatewayClass", Namespaced: false},
			{Name: "httproutes", Kind: "HTTPRoute", Namespaced: true},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1beta1", APIResources: []metav1.APIResource{
			{Name: "gateways", Kind: "Gateway", Namespaced: true},
			{Name: "referencegrants", Kind: "ReferenceGrant", Namespaced: true},
		}},
		{GroupVersion: "gateway.networking.k8s.io/v1alpha3", APIResources: []metav1.APIResource{
			{Name: "backendtlspolicies", Kind: "BackendTLSPolicy", Namespaced: true},
		}},
		{GroupVersion: "resource.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "deviceclasses", Kind: "DeviceClass", Namespaced: false},
			{Name: "resourceclaims", Kind: "ResourceClaim", Namespaced: true},
		}},
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{discovery: disc})
	return s
}

func TestResolveResource_PerKindVersion(t *testing.T) {
	s := newDiscoveryService(t)
	ctx := context.Background()
	for _, tc := range []struct {
		group, resource, wantVersion, wantKind string
		wantNamespaced                         bool
	}{
		{"gateway.networking.k8s.io", "gateways", "v1", "Gateway", true},
		{"gateway.networking.k8s.io", "referencegrants", "v1beta1", "ReferenceGrant", true},
		{"gateway.networking.k8s.io", "backendtlspolicies", "v1alpha3", "BackendTLSPolicy", true},
		{"resource.k8s.io", "deviceclasses", "v1", "DeviceClass", false},
	} {
		res, ok := s.resolveResource(ctx, tc.group, tc.resource)
		if !ok {
			t.Fatalf("%s/%s: not resolved", tc.group, tc.resource)
		}
		if res.GVR.Version != tc.wantVersion || res.Kind != tc.wantKind || res.Namespaced != tc.wantNamespaced {
			t.Errorf("%s/%s: got %s %s namespaced=%v, want %s %s namespaced=%v", tc.group, tc.resource, res.GVR.Version, res.Kind, res.Namespaced, tc.wantVersion, tc.wantKind, tc.wantNamespaced)
		}
	}
}

func TestResolveResource_NotServed(t *testing.T) {
	s := newDiscoveryService(t)
	ctx := context.Background()
	if _, ok := s.resolveResource(ctx, "gateway.networking.k8s.io", "backendtrafficpolicies"); ok {
		t.Fatal("backendtrafficpolicies is not a Gateway API kind; must not resolve")
	}
	if _, ok := s.resolveResource(ctx, "gateway.envoyproxy.io", "backendtrafficpolicies"); ok {
		t.Fatal("group not served; must not resolve")
	}
	// the helpers fall back to a GVR the list will 404 on, and DRA reports unavailable
	if gvr := s.gatewayGVR(ctx, "backendtrafficpolicies"); gvr.Version != "v1" {
		t.Errorf("fallback gateway GVR version = %s, want v1", gvr.Version)
	}
	if v := s.resolveDRAAPIVersion(ctx); v != "v1" {
		t.Errorf("DRA version = %s, want v1", v)
	}
	s2 := &Service{}
	s2.defaultBundle.Store(&clientBundle{discovery: fake.NewSimpleClientset().Discovery()})
	if v := s2.resolveDRAAPIVersion(ctx); v != "unavailable" {
		t.Errorf("DRA version without the group = %s, want unavailable", v)
	}
}

func TestResolveResource_CacheInvalidation(t *testing.T) {
	s := newDiscoveryService(t)
	ctx := context.Background()
	if gvr := s.gatewayGVR(ctx, "referencegrants"); gvr.Version != "v1beta1" {
		t.Fatalf("first resolve = %s", gvr.Version)
	}
	// a kubeconfig reload drops the cache; a cluster that now serves v1 is picked up
	disc := s.discoveryCtx(ctx).(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "gateway.networking.k8s.io/v1", APIResources: []metav1.APIResource{{Name: "referencegrants", Kind: "ReferenceGrant", Namespaced: true}}},
	}
	if gvr := s.gatewayGVR(ctx, "referencegrants"); gvr.Version != "v1beta1" {
		t.Fatalf("cached resolve = %s, want the cached v1beta1", gvr.Version)
	}
	s.invalidateResolveCache()
	if gvr := s.gatewayGVR(ctx, "referencegrants"); gvr.Version != "v1" {
		t.Fatalf("resolve after invalidation = %s, want v1", gvr.Version)
	}
}
