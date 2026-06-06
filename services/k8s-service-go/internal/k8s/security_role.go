package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetRoles lists roles in a namespace.
func (s *Service) GetRoles(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().Roles(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	return formatRoleList(list.Items), nil
}

// GetAllRoles lists roles across all namespaces.
func (s *Service) GetAllRoles(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().Roles("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all roles: %w", err)
	}
	return formatRoleList(list.Items), nil
}

// DescribeRole returns detailed info about a role.
func (s *Service) DescribeRole(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var role *rbacv1.Role
	var events *corev1.EventList
	var roleErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		role, roleErr = s.clientsetCtx(ctx).RbacV1().Roles(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Role", name),
		})
	}()
	wg.Wait()

	if roleErr != nil {
		return nil, fmt.Errorf("get role %s/%s: %w", namespace, name, roleErr)
	}

	result := formatRoleDetail(role)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteRole deletes a role.
func (s *Service) DeleteRole(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).RbacV1().Roles(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatRoleList(items []rbacv1.Role) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, role := range items {
		result = append(result, map[string]interface{}{
			"name":        role.Name,
			"namespace":   role.Namespace,
			"rules_count": len(role.Rules),
			"created_at":  toISO(&role.CreationTimestamp),
			"labels":      role.Labels,
			"annotations": role.Annotations,
		})
	}
	return result
}

func formatRoleDetail(role *rbacv1.Role) map[string]interface{} {
	// Format rules
	rules := make([]map[string]interface{}, 0, len(role.Rules))
	for _, r := range role.Rules {
		rules = append(rules, map[string]interface{}{
			"apiGroups":     r.APIGroups,
			"resources":     r.Resources,
			"verbs":         r.Verbs,
			"resourceNames": r.ResourceNames,
		})
	}

	return map[string]interface{}{
		"name":             role.Name,
		"namespace":        role.Namespace,
		"rules_count":      len(role.Rules),
		"created_at":       toISO(&role.CreationTimestamp),
		"labels":           role.Labels,
		"annotations":      role.Annotations,
		"uid":              string(role.UID),
		"resource_version": role.ResourceVersion,
		"rules":            rules,
	}
}
