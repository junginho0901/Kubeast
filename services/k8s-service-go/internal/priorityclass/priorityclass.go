// Package priorityclass is a PriorityClass as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package priorityclass

import (
	"time"

	schedulingv1 "k8s.io/api/scheduling/v1"
)

// Info is the PriorityClass's row, with the preemption policy the API server defaults when the object has none.
func Info(pc *schedulingv1.PriorityClass) map[string]interface{} {
	preemptionPolicy := "PreemptLowerPriority"
	if pc.PreemptionPolicy != nil {
		preemptionPolicy = string(*pc.PreemptionPolicy)
	}
	created := ""
	if !pc.CreationTimestamp.IsZero() {
		created = pc.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":              pc.Name,
		"value":             pc.Value,
		"global_default":    pc.GlobalDefault,
		"preemption_policy": preemptionPolicy,
		"description":       pc.Description,
		"labels":            pc.Labels,
		"created_at":        created,
	}
}
