package ws

import (
	"context"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drarow"
)

// A live update of a DRA object is the list's row (drarow), for each of the four kinds — none had live updates.
func TestObjectToInfoDRAIsTheListRow(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "resource.k8s.io/v1",
		"metadata":   map[string]interface{}{"name": "gpu", "namespace": "ml", "creationTimestamp": "2026-11-04T01:02:03Z"},
		"spec": map[string]interface{}{
			"driver": "gpu.example.com", "nodeName": "n1", "pool": map[string]interface{}{"name": "n1"},
			"devices": map[string]interface{}{"requests": []interface{}{map[string]interface{}{"name": "gpu"}}},
		},
		"status": map[string]interface{}{"allocation": map[string]interface{}{}, "reservedFor": []interface{}{map[string]interface{}{"name": "p"}}},
	}}
	for resource, row := range map[string]func(*unstructured.Unstructured) map[string]interface{}{
		"deviceclasses": drarow.DeviceClass, "resourceclaims": drarow.Claim, "resourceclaimtemplates": drarow.ClaimTemplate, "resourceslices": drarow.Slice,
	} {
		if got := objectToInfo(resource, u); !reflect.DeepEqual(got, row(u)) {
			t.Errorf("%s: live row %v, list row %v", resource, got, row(u))
		}
		if _, ok := resourceToGVR(resource); !ok {
			t.Errorf("%s: no watch", resource)
		}
	}
	if got := objectToInfo("resourceclaims", u)["state"]; got != "allocated,reserved" {
		t.Errorf("claim state %v", got)
	}
}

// A DRA watch reads the version the cluster serves resource.k8s.io at (a beta before 1.34), as the list does.
func TestServedVersionDRA(t *testing.T) {
	m := NewMultiplexer(resolvingProvider{served: map[string]string{"resourceclaims": "v1beta2"}})
	gvr, _ := resourceToGVR("resourceclaims")
	if got := m.servedVersion(context.Background(), gvr); got.Version != "v1beta2" || got.Group != "resource.k8s.io" {
		t.Errorf("resourceclaims: %v", got)
	}
}
