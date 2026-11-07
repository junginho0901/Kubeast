// Package limitrange is a LimitRange as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package limitrange

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the LimitRange's row: its limits as Items writes them.
func Info(lr *corev1.LimitRange) map[string]interface{} {
	created := ""
	if !lr.CreationTimestamp.IsZero() {
		created = lr.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":       lr.Name,
		"namespace":  lr.Namespace,
		"labels":     lr.Labels,
		"limits":     Items(lr.Spec.Limits),
		"created_at": created,
	}
}

// Items writes limit range items, each value only where the item has it.
func Items(items []corev1.LimitRangeItem) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, li := range items {
		item := map[string]interface{}{
			"type": string(li.Type),
		}
		for field, values := range map[string]corev1.ResourceList{
			"max":             li.Max,
			"min":             li.Min,
			"default":         li.Default,
			"default_request": li.DefaultRequest,
		} {
			if values == nil {
				continue
			}
			written := make(map[string]string, len(values))
			for k, v := range values {
				written[string(k)] = v.String()
			}
			item[field] = written
		}
		result = append(result, item)
	}
	return result
}
