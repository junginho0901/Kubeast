package vpa

import (
	"encoding/json"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// A VPA as the API server returns it with the fields of VPA 1.6 and 1.7 (vertical-pod-autoscaler-1.8.1's
// vpa-v1-crd-gen.yaml): JSON numbers decode to int64, quantities stay as written.
const vpaNewFields = `{"apiVersion":"autoscaling.k8s.io/v1","kind":"VerticalPodAutoscaler","metadata":{"name":"web","namespace":"shop","creationTimestamp":"2026-11-04T01:02:03Z"},
"spec":{"targetRef":{"apiVersion":"apps/v1","kind":"Deployment","name":"web"},
 "updatePolicy":{"updateMode":"InPlace","minReplicas":2,"evictAfterOOMSeconds":300},
 "startupBoost":{"cpu":{"type":"Factor","factor":2,"durationSeconds":10}},
 "resourcePolicy":{"containerPolicies":[
  {"containerName":"app","oomBumpUpRatio":"1.5","oomMinBumpUp":"100Mi","memoryAggregationIntervalSeconds":3600,"memoryAggregationIntervalCount":8,"startupBoost":{"cpu":{"type":"Quantity","quantity":"500m"}}},
  {"containerName":"sidecar","oomBumpUpRatio":2,"mode":"Off"}]}}}`

func TestInfo_FieldsOfVPA17(t *testing.T) {
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON([]byte(vpaNewFields)); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(Info(u))
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]interface{}
	if err := json.Unmarshal(b, &row); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]interface{}{
		"min_replicas": 2.0, "evict_after_oom_seconds": 300.0, "update_mode": "InPlace",
		"startup_boost": map[string]interface{}{"cpu": map[string]interface{}{"type": "Factor", "factor": 2.0, "durationSeconds": 10.0}},
	} {
		if !reflect.DeepEqual(row[k], want) {
			t.Errorf("%s = %#v, want %#v", k, row[k], want)
		}
	}
	policies := row["container_policies"].([]interface{})
	app, sidecar := policies[0].(map[string]interface{}), policies[1].(map[string]interface{})
	for k, want := range map[string]interface{}{
		"oom_bump_up_ratio": "1.5", "oom_min_bump_up": "100Mi", "memory_aggregation_interval_seconds": 3600.0, "memory_aggregation_interval_count": 8.0,
		"startup_boost": map[string]interface{}{"cpu": map[string]interface{}{"type": "Quantity", "quantity": "500m"}},
	} {
		if !reflect.DeepEqual(app[k], want) {
			t.Errorf("app %s = %#v, want %#v", k, app[k], want)
		}
	}
	// what a policy leaves out is not in its row; an int quantity stays a number
	if want := map[string]interface{}{"container_name": "sidecar", "mode": "Off", "oom_bump_up_ratio": 2.0}; !reflect.DeepEqual(sidecar, want) {
		t.Errorf("sidecar = %#v, want %#v", sidecar, want)
	}
}

// The rest kubectl describe prints of a VPA: the update policy's eviction requirements, the recommenders named for it
// and the generation its status last saw, as the API writes them.
func TestInfo_EvictionRequirementsRecommendersObservedGeneration(t *testing.T) {
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON([]byte(`{"apiVersion":"autoscaling.k8s.io/v1","kind":"VerticalPodAutoscaler","metadata":{"name":"web","namespace":"shop"},
	"spec":{"recommenders":[{"name":"custom"}],"updatePolicy":{"updateMode":"Auto","evictionRequirements":[{"resources":["cpu","memory"],"changeRequirement":"TargetHigherThanRequests"}]}},
	"status":{"observedGeneration":7}}`)); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(Info(u))
	if err != nil {
		t.Fatal(err)
	}
	var row map[string]interface{}
	if err := json.Unmarshal(b, &row); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]interface{}{
		"eviction_requirements": []interface{}{map[string]interface{}{"resources": []interface{}{"cpu", "memory"}, "changeRequirement": "TargetHigherThanRequests"}},
		"recommenders":          []interface{}{map[string]interface{}{"name": "custom"}},
		"observed_generation":   7.0,
	} {
		if !reflect.DeepEqual(row[k], want) {
			t.Errorf("%s = %#v, want %#v", k, row[k], want)
		}
	}
}

// A VPA without them (an older CRD prunes them, or the VPA does not set them): null, which the screen shows as "-".
func TestInfo_WithoutTheFieldsOfVPA17(t *testing.T) {
	row := Info(vpa(nil))
	for _, k := range []string{"eviction_requirements", "recommenders", "observed_generation"} {
		if v, ok := row[k]; !ok || v != nil {
			t.Errorf("%s = %#v (present %v), want nil", k, v, ok)
		}
	}
	for _, k := range []string{"min_replicas", "evict_after_oom_seconds", "startup_boost"} {
		if v, ok := row[k]; !ok || v != nil {
			t.Errorf("%s = %#v (present %v), want nil", k, v, ok)
		}
	}
	for _, p := range row["container_policies"].([]map[string]interface{}) {
		for _, k := range []string{"oom_bump_up_ratio", "oom_min_bump_up", "memory_aggregation_interval_seconds", "memory_aggregation_interval_count", "startup_boost"} {
			if _, ok := p[k]; ok {
				t.Errorf("%v has %s", p["container_name"], k)
			}
		}
	}
}
