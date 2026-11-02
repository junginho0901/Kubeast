package vpa

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func vpa(conditions []interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "web", "namespace": "shop", "creationTimestamp": "2026-11-02T01:02:03Z"},
		"spec": map[string]interface{}{
			"targetRef":    map[string]interface{}{"kind": "Deployment", "name": "web"},
			"updatePolicy": map[string]interface{}{"updateMode": "Off"},
			"resourcePolicy": map[string]interface{}{"containerPolicies": []interface{}{
				map[string]interface{}{"containerName": "app", "controlledResources": []interface{}{"cpu"}},
				map[string]interface{}{"containerName": "sidecar"},
			}},
		},
		"status": map[string]interface{}{
			"conditions": conditions,
			"recommendation": map[string]interface{}{"containerRecommendations": []interface{}{
				map[string]interface{}{"containerName": "app", "target": map[string]interface{}{"cpu": "25m", "memory": "64Mi"}},
			}},
		},
	}}
}

// Provided is the RecommendationProvided condition, as the CRD's printer column reads it — not the first condition.
func TestProvidedIsTheRecommendationProvidedCondition(t *testing.T) {
	for _, tc := range []struct {
		conditions []interface{}
		want       string
	}{
		{[]interface{}{
			map[string]interface{}{"type": "LowConfidence", "status": "True"},
			map[string]interface{}{"type": "RecommendationProvided", "status": "False"},
		}, "False"},
		{[]interface{}{map[string]interface{}{"type": "RecommendationProvided", "status": "True"}}, "True"},
		{[]interface{}{map[string]interface{}{"type": "LowConfidence", "status": "True"}}, ""},
		{nil, ""},
	} {
		if got := Info(vpa(tc.conditions))["provided"]; got != tc.want {
			t.Errorf("%v: provided %q, want %q", tc.conditions, got, tc.want)
		}
	}
}

func TestRow(t *testing.T) {
	r := Info(vpa(nil))
	for k, want := range map[string]interface{}{
		"name": "web", "namespace": "shop", "target_ref": "Deployment/web", "update_mode": "Off",
		"cpu_target": "25m", "memory_target": "64Mi", "created_at": "2026-11-02T01:02:03Z",
	} {
		if r[k] != want {
			t.Errorf("%s = %v, want %v", k, r[k], want)
		}
	}
	// a container policy without controlledResources is kept, without the key
	policies := r["container_policies"].([]map[string]interface{})
	if len(policies) != 2 || policies[1]["controlled_resources"] != nil {
		t.Errorf("container policies: %v", policies)
	}
	if none := Info(&unstructured.Unstructured{Object: map[string]interface{}{"metadata": map[string]interface{}{"name": "bare"}}}); none["target_ref"] != "" || none["provided"] != "" {
		t.Errorf("a VPA without spec or status: %v", none)
	}
}
