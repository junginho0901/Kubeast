package ws

import (
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// hpaToInfo — list endpoint: formatHPADetail (hpa.go).
func hpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if spec != nil {
		if ref, ok := spec["scaleTargetRef"].(map[string]interface{}); ok {
			targetRefKind, _ = ref["kind"].(string)
			targetRefName, _ = ref["name"].(string)
			targetRef = targetRefKind + "/" + targetRefName
		}
	}

	var maxReplicas int64
	var minReplicas interface{}
	if spec != nil {
		maxReplicas, _ = toInt64(spec["maxReplicas"])
		if mr, ok := toInt64(spec["minReplicas"]); ok {
			minReplicas = mr
		}
	}

	var currentReplicas, desiredReplicas int64
	var lastScaleTime interface{}
	if status != nil {
		currentReplicas, _ = toInt64(status["currentReplicas"])
		desiredReplicas, _ = toInt64(status["desiredReplicas"])
		lastScaleTime = status["lastScaleTime"]
	}

	// metrics — spec.metrics 와 status.currentMetrics 의 simplified merge.
	// formatHPADetail 의 formatMetricSpec/formatMetricStatus 는 길이가 크기 때문에
	// list 와 watch 가 동일 keys 만 갖도록 raw map 자체를 통과 (frontend 가 동일
	// raw 형태도 처리). 빠진 추가 derived 필드는 다음 reconcile (재 fetch) 에서
	// 채워진다.
	metrics := []map[string]interface{}{}
	if spec != nil {
		if rawMetrics, ok := spec["metrics"].([]interface{}); ok {
			for i, m := range rawMetrics {
				mm, _ := m.(map[string]interface{})
				if mm == nil {
					continue
				}
				entry := hpaMetricSpecToMap(mm)
				if status != nil {
					if curr, ok := status["currentMetrics"].([]interface{}); ok && i < len(curr) {
						if cm, ok := curr[i].(map[string]interface{}); ok {
							entry["current"] = hpaMetricStatusToMap(cm)
						}
					}
				}
				metrics = append(metrics, entry)
			}
		}
	}

	out := map[string]interface{}{
		"name":             metadata["name"],
		"namespace":        metadata["namespace"],
		"target_ref":       targetRef,
		"target_ref_kind":  targetRefKind,
		"target_ref_name":  targetRefName,
		"max_replicas":     maxReplicas,
		"current_replicas": currentReplicas,
		"desired_replicas": desiredReplicas,
		"metrics":          metrics,
		"labels":           metadata["labels"],
		"created_at":       metadata["creationTimestamp"],
	}
	if minReplicas != nil {
		out["min_replicas"] = minReplicas
	}
	if ls, ok := lastScaleTime.(string); ok && ls != "" {
		out["last_scale_time"] = ls
	}
	return out
}

// vpaToInfo — list endpoint: formatVPADetailFromUnstructured (vpa.go).
func vpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if spec != nil {
		if ref, ok := spec["targetRef"].(map[string]interface{}); ok {
			targetRefKind, _ = ref["kind"].(string)
			targetRefName, _ = ref["name"].(string)
			targetRef = fmt.Sprintf("%s/%s", targetRefKind, targetRefName)
		}
	}

	updateMode := ""
	if spec != nil {
		if up, ok := spec["updatePolicy"].(map[string]interface{}); ok {
			updateMode, _ = up["updateMode"].(string)
		}
	}

	// container_policies
	var containerPolicies []map[string]interface{}
	if spec != nil {
		if rp, ok := spec["resourcePolicy"].(map[string]interface{}); ok {
			if cps, ok := rp["containerPolicies"].([]interface{}); ok && len(cps) > 0 {
				containerPolicies = make([]map[string]interface{}, 0, len(cps))
				for _, p := range cps {
					pm, _ := p.(map[string]interface{})
					if pm == nil {
						continue
					}
					cp := map[string]interface{}{
						"container_name": strOrEmpty(pm["containerName"]),
						"mode":           strOrEmpty(pm["mode"]),
					}
					if cr, ok := pm["controlledResources"].([]interface{}); ok && len(cr) > 0 {
						crs := []string{}
						for _, c := range cr {
							if s, ok := c.(string); ok {
								crs = append(crs, s)
							}
						}
						if len(crs) > 0 {
							cp["controlled_resources"] = crs
						}
					}
					if cv, _ := pm["controlledValues"].(string); cv != "" {
						cp["controlled_values"] = cv
					}
					if minA, ok := pm["minAllowed"].(map[string]interface{}); ok {
						cp["min_allowed"] = minA
					}
					if maxA, ok := pm["maxAllowed"].(map[string]interface{}); ok {
						cp["max_allowed"] = maxA
					}
					containerPolicies = append(containerPolicies, cp)
				}
			}
		}
	}

	// conditions
	var conditions []map[string]interface{}
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok && len(conds) > 0 {
			conditions = make([]map[string]interface{}, 0, len(conds))
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				conditions = append(conditions, map[string]interface{}{
					"type":                 strOrEmpty(cm["type"]),
					"status":               strOrEmpty(cm["status"]),
					"reason":               strOrEmpty(cm["reason"]),
					"message":              strOrEmpty(cm["message"]),
					"last_transition_time": strOrEmpty(cm["lastTransitionTime"]),
				})
			}
		}
	}

	// recommendations
	var recommendations []map[string]interface{}
	if status != nil {
		if rec, ok := status["recommendation"].(map[string]interface{}); ok {
			if crs, ok := rec["containerRecommendations"].([]interface{}); ok && len(crs) > 0 {
				recommendations = make([]map[string]interface{}, 0, len(crs))
				for _, r := range crs {
					rm, _ := r.(map[string]interface{})
					if rm == nil {
						continue
					}
					recEntry := map[string]interface{}{
						"container_name": strOrEmpty(rm["containerName"]),
					}
					if t, ok := rm["target"].(map[string]interface{}); ok {
						recEntry["target"] = t
					}
					if l, ok := rm["lowerBound"].(map[string]interface{}); ok {
						recEntry["lower_bound"] = l
					}
					if u, ok := rm["upperBound"].(map[string]interface{}); ok {
						recEntry["upper_bound"] = u
					}
					if uc, ok := rm["uncappedTarget"].(map[string]interface{}); ok {
						recEntry["uncapped_target"] = uc
					}
					recommendations = append(recommendations, recEntry)
				}
			}
		}
	}

	cpuTarget := ""
	memoryTarget := ""
	if len(recommendations) > 0 {
		if t, ok := recommendations[0]["target"].(map[string]interface{}); ok {
			if c, ok := t["cpu"].(string); ok {
				cpuTarget = c
			}
			if m, ok := t["memory"].(string); ok {
				memoryTarget = m
			}
		}
	}

	provided := ""
	if len(conditions) > 0 {
		if s, ok := conditions[0]["status"].(string); ok {
			provided = s
		}
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"target_ref":         targetRef,
		"target_ref_kind":    targetRefKind,
		"target_ref_name":    targetRefName,
		"update_mode":        updateMode,
		"container_policies": containerPolicies,
		"conditions":         conditions,
		"recommendations":    recommendations,
		"cpu_target":         cpuTarget,
		"memory_target":      memoryTarget,
		"provided":           provided,
		"labels":             metadata["labels"],
		"created_at":         metadata["creationTimestamp"],
	}
}

// hpaMetricSpecToMap — spec.metrics[i] raw map 를 list endpoint formatMetricSpec
// 와 같은 snake_case key 형태로 변환 (Resource/Pods/Object/External/ContainerResource).
func hpaMetricSpecToMap(m map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{
		"type": strOrEmpty(m["type"]),
	}
	mtype, _ := m["type"].(string)
	switch mtype {
	case "Resource":
		if res, ok := m["resource"].(map[string]interface{}); ok {
			result["resource_name"] = strOrEmpty(res["name"])
			if target, ok := res["target"].(map[string]interface{}); ok {
				ttype, _ := target["type"].(string)
				if ttype == "Utilization" {
					if v, ok := toInt64(target["averageUtilization"]); ok {
						result["target_average_utilization"] = v
						result["target_type"] = "Utilization"
					}
				} else if av, ok := target["averageValue"].(string); ok && av != "" {
					result["target_average_value"] = av
					result["target_type"] = "AverageValue"
				} else if v, ok := target["value"].(string); ok && v != "" {
					result["target_value"] = v
					result["target_type"] = "Value"
				}
			}
		}
	case "ContainerResource":
		if res, ok := m["containerResource"].(map[string]interface{}); ok {
			result["resource_name"] = strOrEmpty(res["name"])
			result["container_name"] = strOrEmpty(res["container"])
		}
	case "Pods":
		if p, ok := m["pods"].(map[string]interface{}); ok {
			if metric, ok := p["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	case "Object":
		if o, ok := m["object"].(map[string]interface{}); ok {
			if metric, ok := o["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	case "External":
		if e, ok := m["external"].(map[string]interface{}); ok {
			if metric, ok := e["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	}
	return result
}

// hpaMetricStatusToMap — status.currentMetrics[i] raw map 를 simplified
// snake_case shape 으로 변환.
func hpaMetricStatusToMap(m map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{
		"type": strOrEmpty(m["type"]),
	}
	mtype, _ := m["type"].(string)
	switch mtype {
	case "Resource":
		if res, ok := m["current"].(map[string]interface{}); ok {
			if v, ok := toInt64(res["averageUtilization"]); ok {
				result["current_average_utilization"] = v
			}
			if av, ok := res["averageValue"].(string); ok && av != "" {
				result["current_average_value"] = av
			}
		}
	}
	return result
}
