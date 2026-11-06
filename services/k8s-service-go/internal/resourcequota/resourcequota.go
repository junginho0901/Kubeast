// Package resourcequota is a ResourceQuota as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package resourcequota

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the ResourceQuota's row: what the quota controller last wrote as enforced and used.
func Info(rq *corev1.ResourceQuota) map[string]interface{} {
	hard := make(map[string]string)
	used := make(map[string]string)
	for k, v := range rq.Status.Hard {
		hard[string(k)] = v.String()
	}
	for k, v := range rq.Status.Used {
		used[string(k)] = v.String()
	}
	created := ""
	if !rq.CreationTimestamp.IsZero() {
		created = rq.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":        rq.Name,
		"namespace":   rq.Namespace,
		"labels":      rq.Labels,
		"status_hard": hard,
		"status_used": used,
		"created_at":  created,
	}
}
