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
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all rolebindings: %w", err)
		}
		return formatRoleBindingList(list.Items), nil
	})
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
		events, eventsErr = s.objectEvents(ctx, namespace, "RoleBinding", name)
	}()
	wg.Wait()

	if rbErr != nil {
		return nil, fmt.Errorf("get rolebinding %s/%s: %w", namespace, name, rbErr)
	}

	result := formatRoleBindingDetail(rb)

	// Events
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteRoleBinding deletes a rolebinding.
func (s *Service) DeleteRoleBinding(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).RbacV1().RoleBindings(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatRoleBindingList(items []rbacv1.RoleBinding) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, rolebindingrow.Info(&items[i]))
	}
	return result
}

func formatRoleBindingDetail(rb *rbacv1.RoleBinding) map[string]interface{} {
	result := rolebindingrow.Info(rb)
	result["role_ref_api_group"] = rb.RoleRef.APIGroup
	result["uid"] = string(rb.UID)
	result["resource_version"] = rb.ResourceVersion
	return result
}
