package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolebindingrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/rolebinding"
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
		events, eventsErr = s.objectEvents(ctx, "", "ClusterRoleBinding", name)
	}()
	wg.Wait()

	if crbErr != nil {
		return nil, fmt.Errorf("get clusterrolebinding %s: %w", name, crbErr)
	}

	result := formatClusterRoleBindingDetail(crb)
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteClusterRoleBinding deletes a clusterrolebinding.
func (s *Service) DeleteClusterRoleBinding(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).RbacV1().ClusterRoleBindings().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatClusterRoleBindingList(items []rbacv1.ClusterRoleBinding) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, rolebindingrow.Cluster(&items[i]))
	}
	return result
}

func formatClusterRoleBindingDetail(crb *rbacv1.ClusterRoleBinding) map[string]interface{} {
	result := rolebindingrow.Cluster(crb)
	result["role_ref_api_group"] = crb.RoleRef.APIGroup
	result["uid"] = string(crb.UID)
	result["resource_version"] = crb.ResourceVersion
	return result
}
