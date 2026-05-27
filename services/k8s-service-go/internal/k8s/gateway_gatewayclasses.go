package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetGatewayClasses lists all gateway classes.
func (s *Service) GetGatewayClasses(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gatewayclasses")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list gateway classes: %w", err)
	}
	return formatUnstructuredList(list), nil
}

// DescribeGatewayClass returns detailed info about a gateway class.
func (s *Service) DescribeGatewayClass(ctx context.Context, name string) (map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gatewayclasses")
	obj, err := s.GetResource(ctx, gvr, "", name)
	if err != nil {
		return nil, fmt.Errorf("get gateway class %s: %w", name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		result["controller_name"] = mapStr(spec, "controllerName")
		result["description"] = mapStr(spec, "description")

		if paramRef := mapMap(spec, "parametersRef"); paramRef != nil {
			result["parameters_ref"] = paramRef
		}
	}

	status := mapMap(obj.Object, "status")
	if status != nil {
		conditions := mapSlice(status, "conditions")
		condList := make([]map[string]interface{}, 0, len(conditions))
		for _, c := range conditions {
			if cm, ok := c.(map[string]interface{}); ok {
				condList = append(condList, map[string]interface{}{
					"type":                 mapStr(cm, "type"),
					"status":               mapStr(cm, "status"),
					"reason":               mapStr(cm, "reason"),
					"message":              mapStr(cm, "message"),
					"last_transition_time": mapStr(cm, "lastTransitionTime"),
				})
			}
		}
		result["conditions"] = condList
	}

	return result, nil
}

// DeleteGatewayClass deletes a gateway class.
func (s *Service) DeleteGatewayClass(ctx context.Context, name string) error {
	gvr := s.gatewayGVR(ctx, "gatewayclasses")
	return s.DeleteResource(ctx, gvr, "", name)
}
