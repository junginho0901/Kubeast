// Package clusterrole is a ClusterRole as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package clusterrole

import (
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
)

// Info is the ClusterRole's row: how many rules it has, its labels and annotations.
func Info(cr *rbacv1.ClusterRole) map[string]interface{} {
	created := ""
	if !cr.CreationTimestamp.IsZero() {
		created = cr.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":        cr.Name,
		"rules_count": len(cr.Rules),
		"created_at":  created,
		"labels":      cr.Labels,
		"annotations": cr.Annotations,
	}
}
