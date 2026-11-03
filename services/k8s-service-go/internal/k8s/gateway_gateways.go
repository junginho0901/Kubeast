package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetGateways lists gateways in a namespace.
func (s *Service) GetGateways(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gateways")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list gateways: %w", err)
	}
	return gatewayRows(list, gatewayrow.Gateway), nil
}

// GetAllGateways lists gateways across all namespaces.
func (s *Service) GetAllGateways(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		gvr := s.gatewayGVR(ctx, "gateways")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all gateways: %w", err)
		}
		return gatewayRows(list, gatewayrow.Gateway), nil
	})
}

// DescribeGateway is a gateway as its drawer shows it: the list's row (gatewayrow.Gateway), its metadata and events.
func (s *Service) DescribeGateway(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	result, _, err := s.describeGatewayObject(ctx, "gateways", "Gateway", namespace, name, gatewayrow.Gateway)
	if err != nil {
		return nil, fmt.Errorf("get gateway %s/%s: %w", namespace, name, err)
	}
	return result, nil
}

// DeleteGateway deletes a gateway.
func (s *Service) DeleteGateway(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "gateways")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
