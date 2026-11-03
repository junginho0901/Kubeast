package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetHTTPRoutes lists HTTP routes in a namespace.
func (s *Service) GetHTTPRoutes(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "httproutes")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list httproutes: %w", err)
	}
	return gatewayRows(list, gatewayrow.Route), nil
}

// GetAllHTTPRoutes lists HTTP routes across all namespaces.
func (s *Service) GetAllHTTPRoutes(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		gvr := s.gatewayGVR(ctx, "httproutes")
		list, err := s.ListResources(ctx, gvr, ns, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all httproutes: %w", err)
		}
		return gatewayRows(list, gatewayrow.Route), nil
	})
}

// DescribeHTTPRoute is an HTTP route as its drawer shows it: the list's row (gatewayrow.Route) — the rules, backends
// and parents as the spec and status write them — its metadata and events.
func (s *Service) DescribeHTTPRoute(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	result, _, err := s.describeGatewayObject(ctx, "httproutes", "HTTPRoute", namespace, name, gatewayrow.Route)
	if err != nil {
		return nil, fmt.Errorf("get httproute %s/%s: %w", namespace, name, err)
	}
	return result, nil
}

// DeleteHTTPRoute deletes an HTTP route.
func (s *Service) DeleteHTTPRoute(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "httproutes")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
