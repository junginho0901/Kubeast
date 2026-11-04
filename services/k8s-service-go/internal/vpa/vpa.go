// Package vpa builds a VerticalPodAutoscaler's row once for the list, describe and the live updates, so the three show
// the same values. Provided is the RecommendationProvided condition's status, as the CRD's printer column
// (`.status.conditions[?(@.type=='RecommendationProvided')].status`) prints it — not the first condition's.
package vpa

import (
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func object(m map[string]interface{}, key string) map[string]interface{} {
	v, _ := m[key].(map[string]interface{})
	return v
}

func list(m map[string]interface{}, key string) []map[string]interface{} {
	raw, _ := m[key].([]interface{})
	out := make([]map[string]interface{}, 0, len(raw))
	for _, r := range raw {
		if o, ok := r.(map[string]interface{}); ok {
			out = append(out, o)
		}
	}
	return out
}

func str(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

// Info is the VPA's row.
func Info(u *unstructured.Unstructured) map[string]interface{} {
	spec := object(u.Object, "spec")
	status := object(u.Object, "status")

	targetRef, kind, name, apiVersion := "", "", "", ""
	if ref := object(spec, "targetRef"); ref != nil {
		kind, name, apiVersion = str(ref, "kind"), str(ref, "name"), str(ref, "apiVersion")
		targetRef = fmt.Sprintf("%s/%s", kind, name)
	}

	var containerPolicies []map[string]interface{}
	for _, p := range list(object(spec, "resourcePolicy"), "containerPolicies") {
		cp := map[string]interface{}{"container_name": str(p, "containerName"), "mode": str(p, "mode")}
		var controlled []string
		raw, _ := p["controlledResources"].([]interface{})
		for _, r := range raw {
			if s, ok := r.(string); ok {
				controlled = append(controlled, s)
			}
		}
		if len(controlled) > 0 {
			cp["controlled_resources"] = controlled
		}
		if v := str(p, "controlledValues"); v != "" {
			cp["controlled_values"] = v
		}
		if v := object(p, "minAllowed"); v != nil {
			cp["min_allowed"] = v
		}
		if v := object(p, "maxAllowed"); v != nil {
			cp["max_allowed"] = v
		}
		// fields of VPA 1.6 and 1.7 (vpa-v1-crd-gen.yaml) as written: a quantity int or string, startupBoost an object
		for from, to := range map[string]string{
			"oomBumpUpRatio": "oom_bump_up_ratio", "oomMinBumpUp": "oom_min_bump_up", "startupBoost": "startup_boost",
			"memoryAggregationIntervalSeconds": "memory_aggregation_interval_seconds", "memoryAggregationIntervalCount": "memory_aggregation_interval_count",
		} {
			if v, ok := p[from]; ok && v != nil {
				cp[to] = v
			}
		}
		containerPolicies = append(containerPolicies, cp)
	}

	var conditions []map[string]interface{}
	provided := ""
	for _, c := range list(status, "conditions") {
		conditions = append(conditions, map[string]interface{}{
			"type":                 str(c, "type"),
			"status":               str(c, "status"),
			"reason":               str(c, "reason"),
			"message":              str(c, "message"),
			"last_transition_time": str(c, "lastTransitionTime"),
		})
		if str(c, "type") == "RecommendationProvided" {
			provided = str(c, "status")
		}
	}

	var recommendations []map[string]interface{}
	for _, r := range list(object(status, "recommendation"), "containerRecommendations") {
		rec := map[string]interface{}{"container_name": str(r, "containerName")}
		for from, to := range map[string]string{"target": "target", "lowerBound": "lower_bound", "upperBound": "upper_bound", "uncappedTarget": "uncapped_target"} {
			if v := object(r, from); v != nil {
				rec[to] = v
			}
		}
		recommendations = append(recommendations, rec)
	}
	cpu, memory := "", ""
	if len(recommendations) > 0 {
		if target, ok := recommendations[0]["target"].(map[string]interface{}); ok {
			cpu, _ = target["cpu"].(string)
			memory, _ = target["memory"].(string)
		}
	}
	updatePolicy := object(spec, "updatePolicy")

	return map[string]interface{}{
		// the CRD's wide columns MinReplicas and OOMSeconds (VPA 1.7) and the pod's startupBoost, as written; nil without
		"min_replicas":            updatePolicy["minReplicas"],
		"evict_after_oom_seconds": updatePolicy["evictAfterOOMSeconds"],
		"startup_boost":           spec["startupBoost"],

		"name":               u.GetName(),
		"namespace":          u.GetNamespace(),
		"target_ref":         targetRef,
		"target_ref_kind":    kind,
		"target_ref_name":    name,
		"update_mode":        str(object(spec, "updatePolicy"), "updateMode"),
		"container_policies": containerPolicies,
		"conditions":         conditions,
		"recommendations":    recommendations,
		"cpu_target":         cpu,
		"memory_target":      memory,
		"provided":           provided,
		"labels":             u.GetLabels(),
		"created_at":         u.GetCreationTimestamp().UTC().Format(time.RFC3339),
		// the target's apiVersion, so a Kind two groups serve opens the right object
		"target_ref_api_version": apiVersion,
	}
}
