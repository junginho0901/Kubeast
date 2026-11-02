package ws

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	vparow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/vpa"
)

// A VPA's live update is the list's row (internal/vpa).
func TestObjectToInfoVPAIsTheListRow(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "web", "namespace": "shop", "creationTimestamp": "2026-11-02T01:02:03Z"},
		"spec":     map[string]interface{}{"targetRef": map[string]interface{}{"kind": "Deployment", "name": "web"}},
		"status": map[string]interface{}{"conditions": []interface{}{
			map[string]interface{}{"type": "LowConfidence", "status": "True"},
			map[string]interface{}{"type": "RecommendationProvided", "status": "False"},
		}},
	}}
	if got := objectToInfo("verticalpodautoscalers", u); !reflect.DeepEqual(got, vparow.Info(u)) {
		t.Fatalf("live row %v, list row %v", got, vparow.Info(u))
	}
}
