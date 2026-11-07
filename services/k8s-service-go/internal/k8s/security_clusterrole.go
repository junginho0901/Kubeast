package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	clusterrolerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/clusterrole"
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
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteClusterRole deletes a clusterrole.
func (s *Service) DeleteClusterRole(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).RbacV1().ClusterRoles().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatClusterRoleList(items []rbacv1.ClusterRole) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, clusterrolerow.Info(&items[i]))
	}
	return result
}

// formatClusterRoleDetail hands the rules and the aggregation rule over as the API writes them, so a rule's
// nonResourceURLs and a selector's matchExpressions reach the drawer as kubectl describe shows them.
func formatClusterRoleDetail(cr *rbacv1.ClusterRole) map[string]interface{} {
	rules := cr.Rules
	if rules == nil {
		rules = []rbacv1.PolicyRule{}
	}
	var aggregation interface{}
	if cr.AggregationRule != nil {
		aggregation = asJSON(cr.AggregationRule)
	}

	result := clusterrolerow.Info(cr)
	result["uid"] = string(cr.UID)
	result["resource_version"] = cr.ResourceVersion
	result["rules"] = asJSON(rules)
	result["aggregation_rule"] = aggregation
	return result
}
