package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetGRPCRoutes lists GRPC routes in a namespace.
func (s *Service) GetGRPCRoutes(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "grpcroutes")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list grpcroutes: %w", err)
	}
	return gatewayRows(list, gatewayrow.Route), nil
}

// GetAllGRPCRoutes lists GRPC routes across all namespaces.
func (s *Service) GetAllGRPCRoutes(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		gvr := s.gatewayGVR(ctx, "grpcroutes")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all grpcroutes: %w", err)
		}
		return gatewayRows(list, gatewayrow.Route), nil
	})
}

// DescribeGRPCRoute is a GRPC route as its drawer shows it: the list's row (gatewayrow.Route) — the rules, backends
// and parents as the spec and status write them — its metadata and events.
func (s *Service) DescribeGRPCRoute(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	result, _, err := s.describeGatewayObject(ctx, "grpcroutes", "GRPCRoute", namespace, name, gatewayrow.Route)
	if err != nil {
		return nil, fmt.Errorf("get grpcroute %s/%s: %w", namespace, name, err)
	}
	return result, nil
}

// DeleteGRPCRoute deletes a GRPC route.
func (s *Service) DeleteGRPCRoute(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "grpcroutes")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
