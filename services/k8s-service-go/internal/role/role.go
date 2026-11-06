// Package role is a Role as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package role

import (
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
)

// Info is the Role's row: how many rules it has, its labels and annotations.
func Info(r *rbacv1.Role) map[string]interface{} {
	created := ""
	if !r.CreationTimestamp.IsZero() {
		created = r.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":        r.Name,
		"namespace":   r.Namespace,
		"rules_count": len(r.Rules),
		"created_at":  created,
		"labels":      r.Labels,
		"annotations": r.Annotations,
	}
}
