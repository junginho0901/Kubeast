package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/gatewayrow"
)

// GetGatewayClasses lists all gateway classes.
func (s *Service) GetGatewayClasses(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gatewayclasses")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list gateway classes: %w", err)
	}
	return gatewayRows(list, gatewayrow.GatewayClass), nil
}

// DescribeGatewayClass is a gateway class as its drawer shows it: the list's row (gatewayrow.GatewayClass), its
// metadata and events, and the features the controller says it supports.
func (s *Service) DescribeGatewayClass(ctx context.Context, name string) (map[string]interface{}, error) {
	result, obj, err := s.describeGatewayObject(ctx, "gatewayclasses", "GatewayClass", "", name, gatewayrow.GatewayClass)
	if err != nil {
		return nil, fmt.Errorf("get gateway class %s: %w", name, err)
	}

	status := mapMap(obj.Object, "status")
	if status != nil {
		supported := mapSlice(status, "supportedFeatures")
		features := make([]map[string]interface{}, 0, len(supported))
		for _, f := range supported {
			switch v := f.(type) {
			case string:
				features = append(features, map[string]interface{}{"name": v})
			case map[string]interface{}:
				features = append(features, map[string]interface{}{
					"name": mapStr(v, "name"),
				})
			}
		}
		if len(features) > 0 {
			result["supported_features"] = features
		}
	}

	return result, nil
}

// DeleteGatewayClass deletes a gateway class.
func (s *Service) DeleteGatewayClass(ctx context.Context, name string) error {
	gvr := s.gatewayGVR(ctx, "gatewayclasses")
	return s.DeleteResource(ctx, gvr, "", name)
}
