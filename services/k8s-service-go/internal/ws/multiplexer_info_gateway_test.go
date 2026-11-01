package ws

import (
	"context"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// A live update of a Gateway API object is the list's row (gatewayrow), for each kind the list pages show — the
// three that had no live updates included.
func TestObjectToInfoGatewayIsTheListRow(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"metadata":   map[string]interface{}{"name": "one", "namespace": "shop", "creationTimestamp": "2026-11-01T03:04:05Z"},
		"spec":       map[string]interface{}{"gatewayClassName": "eg", "listeners": []interface{}{map[string]interface{}{"name": "http"}}},
	}}
	for resource, row := range map[string]func(*unstructured.Unstructured) map[string]interface{}{
		"gatewayclasses": gatewayrow.GatewayClass, "gateways": gatewayrow.Gateway, "httproutes": gatewayrow.Route,
		"grpcroutes": gatewayrow.Route, "referencegrants": gatewayrow.ReferenceGrant, "backendtlspolicies": gatewayrow.Policy,
	} {
		if got := objectToInfo(resource, u); !reflect.DeepEqual(got, row(u)) {
			t.Errorf("%s: live row %v, list row %v", resource, got, row(u))
		}
		if _, ok := resourceToGVR(resource); !ok {
			t.Errorf("%s: no watch", resource)
		}
	}
}

type resolvingProvider struct{ served map[string]string }

func (resolvingProvider) Clientset() *kubernetes.Clientset                { return nil }
func (resolvingProvider) Dynamic() dynamic.Interface                      { return nil }
func (resolvingProvider) DynamicForCtx(context.Context) dynamic.Interface { return nil }
func (p resolvingProvider) ResolveGVR(_ context.Context, group, resource string) (schema.GroupVersionResource, bool) {
	v, ok := p.served[resource]
	return schema.GroupVersionResource{Group: group, Version: v, Resource: resource}, ok
}

// A Gateway API watch reads the version the cluster serves, as the list does; other groups keep theirs.
func TestServedVersion(t *testing.T) {
	m := NewMultiplexer(resolvingProvider{served: map[string]string{"backendtlspolicies": "v1", "gateways": "v1"}})
	gvr, _ := resourceToGVR("backendtlspolicies")
	if got := m.servedVersion(context.Background(), gvr); got.Version != "v1" {
		t.Errorf("backendtlspolicies: %v", got)
	}
	gvr, _ = resourceToGVR("referencegrants")
	if got := m.servedVersion(context.Background(), gvr); got.Version != "v1beta1" {
		t.Errorf("not served: keep the default, %v", got)
	}
	gvr, _ = resourceToGVR("verticalpodautoscalers")
	if got := m.servedVersion(context.Background(), gvr); got.Version != "v1" || got.Group != "autoscaling.k8s.io" {
		t.Errorf("another group: %v", got)
	}
}
