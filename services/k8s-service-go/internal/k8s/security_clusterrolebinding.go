package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetClusterRoleBindings lists clusterrolebindings (cluster-scoped).
func (s *Service) GetClusterRoleBindings(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list clusterrolebindings: %w", err)
	}
	return formatClusterRoleBindingList(list.Items), nil
}

// DescribeClusterRoleBinding returns detailed info about a clusterrolebinding.
func (s *Service) DescribeClusterRoleBinding(ctx context.Context, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var crb *rbacv1.ClusterRoleBinding
	var events *corev1.EventList
	var crbErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		crb, crbErr = s.clientsetCtx(ctx).RbacV1().ClusterRoleBindings().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ClusterRoleBinding", name),
		})
	}()
	wg.Wait()

	if crbErr != nil {
		return nil, fmt.Errorf("get clusterrolebinding %s: %w", name, crbErr)
	}

	result := formatClusterRoleBindingDetail(crb)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteClusterRoleBinding deletes a clusterrolebinding.
func (s *Service) DeleteClusterRoleBinding(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).RbacV1().ClusterRoleBindings().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatClusterRoleBindingList(items []rbacv1.ClusterRoleBinding) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, crb := range items {
		subjects := make([]map[string]interface{}, 0, len(crb.Subjects))
		for _, s := range crb.Subjects {
			subjects = append(subjects, map[string]interface{}{
				"kind":      s.Kind,
				"name":      s.Name,
				"namespace": s.Namespace,
				"apiGroup":  s.APIGroup,
			})
		}
		result = append(result, map[string]interface{}{
			"name":           crb.Name,
			"role_ref_kind":  crb.RoleRef.Kind,
			"role_ref_name":  crb.RoleRef.Name,
			"subjects_count": len(crb.Subjects),
			"subjects":       subjects,
			"created_at":     toISO(&crb.CreationTimestamp),
			"labels":         crb.Labels,
			"annotations":    crb.Annotations,
		})
	}
	return result
}

func formatClusterRoleBindingDetail(crb *rbacv1.ClusterRoleBinding) map[string]interface{} {
	// Format subjects
	subjects := make([]map[string]interface{}, 0, len(crb.Subjects))
	for _, s := range crb.Subjects {
		subjects = append(subjects, map[string]interface{}{
			"kind":      s.Kind,
			"name":      s.Name,
			"namespace": s.Namespace,
			"apiGroup":  s.APIGroup,
		})
	}

	return map[string]interface{}{
		"name":               crb.Name,
		"role_ref_kind":      crb.RoleRef.Kind,
		"role_ref_name":      crb.RoleRef.Name,
		"role_ref_api_group": crb.RoleRef.APIGroup,
		"subjects_count":     len(crb.Subjects),
		"subjects":           subjects,
		"created_at":         toISO(&crb.CreationTimestamp),
		"labels":             crb.Labels,
		"annotations":        crb.Annotations,
		"uid":                string(crb.UID),
		"resource_version":   crb.ResourceVersion,
	}
}
