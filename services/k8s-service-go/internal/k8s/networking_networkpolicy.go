package k8s

import (
	"context"
	"fmt"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	netpolrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/networkpolicy"
)

// ========== NetworkPolicies ==========

// GetNetworkPolicies lists network policies in a namespace.
func (s *Service) GetNetworkPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list network policies: %w", err)
	}
	return formatNetworkPolicyList(list.Items), nil
}

// GetAllNetworkPolicies lists network policies across all namespaces.
func (s *Service) GetAllNetworkPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all network policies: %w", err)
		}
		return formatNetworkPolicyList(list.Items), nil
	})
}

// DescribeNetworkPolicy returns detailed info about a network policy.
func (s *Service) DescribeNetworkPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	np, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get network policy %s/%s: %w", namespace, name, err)
	}

	// the row already includes all fields
	return netpolrow.Info(np), nil
}

// DeleteNetworkPolicy deletes a network policy.
func (s *Service) DeleteNetworkPolicy(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatNetworkPolicyList(items []networkingv1.NetworkPolicy) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, netpolrow.Info(&items[i]))
	}
	return result
}
