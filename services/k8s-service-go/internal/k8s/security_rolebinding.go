package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetRoleBindings lists rolebindings in a namespace.
func (s *Service) GetRoleBindings(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list rolebindings: %w", err)
	}
	return formatRoleBindingList(list.Items), nil
}

// GetAllRoleBindings lists rolebindings across all namespaces.
func (s *Service) GetAllRoleBindings(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all rolebindings: %w", err)
	}
	return formatRoleBindingList(list.Items), nil
}

// DescribeRoleBinding returns detailed info about a rolebinding.
func (s *Service) DescribeRoleBinding(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var rb *rbacv1.RoleBinding
	var events *corev1.EventList
	var rbErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		rb, rbErr = s.clientsetCtx(ctx).RbacV1().RoleBindings(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=RoleBinding", name),
		})
	}()
	wg.Wait()

	if rbErr != nil {
		return nil, fmt.Errorf("get rolebinding %s/%s: %w", namespace, name, rbErr)
	}

	result := formatRoleBindingDetail(rb)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteRoleBinding deletes a rolebinding.
func (s *Service) DeleteRoleBinding(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).RbacV1().RoleBindings(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatRoleBindingList(items []rbacv1.RoleBinding) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, rb := range items {
		subjects := make([]map[string]interface{}, 0, len(rb.Subjects))
		for _, s := range rb.Subjects {
			subjects = append(subjects, map[string]interface{}{
				"kind":      s.Kind,
				"name":      s.Name,
				"namespace": s.Namespace,
				"apiGroup":  s.APIGroup,
			})
		}
		result = append(result, map[string]interface{}{
			"name":           rb.Name,
			"namespace":      rb.Namespace,
			"role_ref_kind":  rb.RoleRef.Kind,
			"role_ref_name":  rb.RoleRef.Name,
			"subjects_count": len(rb.Subjects),
			"subjects":       subjects,
			"created_at":     toISO(&rb.CreationTimestamp),
			"labels":         rb.Labels,
			"annotations":    rb.Annotations,
		})
	}
	return result
}

func formatRoleBindingDetail(rb *rbacv1.RoleBinding) map[string]interface{} {
	// Format subjects
	subjects := make([]map[string]interface{}, 0, len(rb.Subjects))
	for _, s := range rb.Subjects {
		subjects = append(subjects, map[string]interface{}{
			"kind":      s.Kind,
			"name":      s.Name,
			"namespace": s.Namespace,
			"apiGroup":  s.APIGroup,
		})
	}

	return map[string]interface{}{
		"name":               rb.Name,
		"namespace":          rb.Namespace,
		"role_ref_kind":      rb.RoleRef.Kind,
		"role_ref_name":      rb.RoleRef.Name,
		"role_ref_api_group": rb.RoleRef.APIGroup,
		"subjects_count":     len(rb.Subjects),
		"subjects":           subjects,
		"created_at":         toISO(&rb.CreationTimestamp),
		"labels":             rb.Labels,
		"annotations":        rb.Annotations,
		"uid":                string(rb.UID),
		"resource_version":   rb.ResourceVersion,
	}
}
