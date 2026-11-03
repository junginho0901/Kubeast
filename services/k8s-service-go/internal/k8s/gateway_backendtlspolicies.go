package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetBackendTLSPolicies lists BackendTLSPolicies in a namespace.
func (s *Service) GetBackendTLSPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "backendtlspolicies")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list backendtlspolicies: %w", err)
	}
	return gatewayRows(list, gatewayrow.Policy), nil
}

// GetAllBackendTLSPolicies lists BackendTLSPolicies across all namespaces.
func (s *Service) GetAllBackendTLSPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		gvr := s.gatewayGVR(ctx, "backendtlspolicies")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all backendtlspolicies: %w", err)
		}
		return gatewayRows(list, gatewayrow.Policy), nil
	})
}

// DescribeBackendTLSPolicy is a BackendTLSPolicy as its drawer shows it: the list's row (gatewayrow.Policy), its
// metadata and events, the TLS validation and every ancestor's status as the object writes them.
func (s *Service) DescribeBackendTLSPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	result, obj, err := s.describeGatewayObject(ctx, "backendtlspolicies", "BackendTLSPolicy", namespace, name, gatewayrow.Policy)
	if err != nil {
		return nil, fmt.Errorf("get backendtlspolicy %s/%s: %w", namespace, name, err)
	}
	if validation := mapMap(mapMap(obj.Object, "spec"), "validation"); validation != nil {
		result["validation"] = validation
	}
	ancestors := []interface{}{}
	if status := mapMap(obj.Object, "status"); status != nil {
		ancestors = append(ancestors, mapSlice(status, "ancestors")...)
	}
	result["ancestors"] = ancestors
	return result, nil
}

// DeleteBackendTLSPolicy deletes a BackendTLSPolicy.
func (s *Service) DeleteBackendTLSPolicy(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "backendtlspolicies")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
