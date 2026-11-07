// Package rolebinding is a RoleBinding or a ClusterRoleBinding as Kubeast lists it, one row for the list, the drawer and
// the live list updates alike.
package rolebinding

import (
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Info is the RoleBinding's row: the role it names and its subjects.
func Info(rb *rbacv1.RoleBinding) map[string]interface{} {
	row := row(&rb.ObjectMeta, rb.RoleRef, rb.Subjects)
	row["namespace"] = rb.Namespace
	return row
}

// Cluster is the ClusterRoleBinding's row: the role it names and its subjects.
func Cluster(crb *rbacv1.ClusterRoleBinding) map[string]interface{} {
	return row(&crb.ObjectMeta, crb.RoleRef, crb.Subjects)
}

func row(meta *metav1.ObjectMeta, ref rbacv1.RoleRef, subjects []rbacv1.Subject) map[string]interface{} {
	listed := make([]map[string]interface{}, 0, len(subjects))
	for _, s := range subjects {
		listed = append(listed, map[string]interface{}{
			"kind":      s.Kind,
			"name":      s.Name,
			"namespace": s.Namespace,
			"apiGroup":  s.APIGroup,
		})
	}
	created := ""
	if !meta.CreationTimestamp.IsZero() {
		created = meta.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":           meta.Name,
		"role_ref_kind":  ref.Kind,
		"role_ref_name":  ref.Name,
		"subjects_count": len(subjects),
		"subjects":       listed,
		"created_at":     created,
		"labels":         meta.Labels,
		"annotations":    meta.Annotations,
	}
}
