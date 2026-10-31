package k8s

import (
	"context"
	"fmt"

	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpointslice"
)

// ========== EndpointSlices ==========

// GetEndpointSlices lists endpoint slices in a namespace.
func (s *Service) GetEndpointSlices(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list endpoint slices: %w", err)
	}
	return formatEndpointSliceList(list.Items), nil
}

// GetAllEndpointSlices lists endpoint slices across all namespaces.
func (s *Service) GetAllEndpointSlices(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all endpoint slices: %w", err)
		}
		return formatEndpointSliceList(list.Items), nil
	})
}

// DescribeEndpointSlice returns detailed info about an endpoint slice.
func (s *Service) DescribeEndpointSlice(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	es, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get endpoint slice %s/%s: %w", namespace, name, err)
	}

	return endpointslice.Info(es), nil
}

// DeleteEndpointSlice deletes an endpoint slice.
func (s *Service) DeleteEndpointSlice(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatEndpointSliceList(items []discoveryv1.EndpointSlice) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, endpointslice.Info(&items[i]))
	}
	return result
}
