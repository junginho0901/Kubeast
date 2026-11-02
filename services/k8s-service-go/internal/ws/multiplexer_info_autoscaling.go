package ws

import (
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
	scalingActive := false
	if status != nil {
		currentReplicas, _ = toInt64(status["currentReplicas"])
		desiredReplicas, _ = toInt64(status["desiredReplicas"])
		lastScaleTime = status["lastScaleTime"]
		conds, _ := status["conditions"].([]interface{})
		for _, c := range conds {
			if cm, _ := c.(map[string]interface{}); cm != nil && cm["type"] == "ScalingActive" {
				scalingActive = cm["status"] == "True"
			}
		}
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
		"scaling_active":   scalingActive,
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
