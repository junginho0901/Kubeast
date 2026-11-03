package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetReferenceGrants lists reference grants in a namespace.
func (s *Service) GetReferenceGrants(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list referencegrants: %w", err)
	}
	return gatewayRows(list, gatewayrow.ReferenceGrant), nil
}

// GetAllReferenceGrants lists reference grants across all namespaces.
func (s *Service) GetAllReferenceGrants(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		gvr := s.gatewayGVR(ctx, "referencegrants")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all referencegrants: %w", err)
		}
		return gatewayRows(list, gatewayrow.ReferenceGrant), nil
	})
}

// DescribeReferenceGrant is a reference grant as its drawer shows it: the list's row (gatewayrow.ReferenceGrant), its
// metadata and events. A ReferenceGrant has no status.
func (s *Service) DescribeReferenceGrant(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	result, _, err := s.describeGatewayObject(ctx, "referencegrants", "ReferenceGrant", namespace, name, gatewayrow.ReferenceGrant)
	if err != nil {
		return nil, fmt.Errorf("get referencegrant %s/%s: %w", namespace, name, err)
	}
	return result, nil
}

// DeleteReferenceGrant deletes a reference grant.
func (s *Service) DeleteReferenceGrant(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
