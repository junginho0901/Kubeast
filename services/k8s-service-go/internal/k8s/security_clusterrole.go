package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetClusterRoles lists clusterroles (cluster-scoped).
func (s *Service) GetClusterRoles(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).RbacV1().ClusterRoles().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list clusterroles: %w", err)
	}
	return formatClusterRoleList(list.Items), nil
}

// DescribeClusterRole returns detailed info about a clusterrole.
func (s *Service) DescribeClusterRole(ctx context.Context, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var cr *rbacv1.ClusterRole
	var events *corev1.EventList
	var crErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		cr, crErr = s.clientsetCtx(ctx).RbacV1().ClusterRoles().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ClusterRole", name),
		})
	}()
	wg.Wait()

	if crErr != nil {
		return nil, fmt.Errorf("get clusterrole %s: %w", name, crErr)
	}

	result := formatClusterRoleDetail(cr)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteClusterRole deletes a clusterrole.
func (s *Service) DeleteClusterRole(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).RbacV1().ClusterRoles().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatClusterRoleList(items []rbacv1.ClusterRole) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, cr := range items {
		result = append(result, map[string]interface{}{
			"name":        cr.Name,
			"rules_count": len(cr.Rules),
			"created_at":  toISO(&cr.CreationTimestamp),
			"labels":      cr.Labels,
			"annotations": cr.Annotations,
		})
	}
	return result
}

func formatClusterRoleDetail(cr *rbacv1.ClusterRole) map[string]interface{} {
	// Format rules
	rules := make([]map[string]interface{}, 0, len(cr.Rules))
	for _, r := range cr.Rules {
		rules = append(rules, map[string]interface{}{
			"apiGroups":     r.APIGroups,
			"resources":     r.Resources,
			"verbs":         r.Verbs,
			"resourceNames": r.ResourceNames,
		})
	}

	// Format aggregation rule (ClusterRole-only — Role 에 없는 필드)
	var aggregation map[string]interface{}
	if cr.AggregationRule != nil {
		selectors := make([]map[string]interface{}, 0, len(cr.AggregationRule.ClusterRoleSelectors))
		for _, sel := range cr.AggregationRule.ClusterRoleSelectors {
			selectors = append(selectors, map[string]interface{}{
				"matchLabels": sel.MatchLabels,
			})
		}
		aggregation = map[string]interface{}{
			"clusterRoleSelectors": selectors,
		}
	}

	return map[string]interface{}{
		"name":             cr.Name,
		"rules_count":      len(cr.Rules),
		"created_at":       toISO(&cr.CreationTimestamp),
		"labels":           cr.Labels,
		"annotations":      cr.Annotations,
		"uid":              string(cr.UID),
		"resource_version": cr.ResourceVersion,
		"rules":            rules,
		"aggregation_rule": aggregation,
	}
}
