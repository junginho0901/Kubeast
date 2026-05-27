package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetGateways lists gateways in a namespace.
func (s *Service) GetGateways(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gateways")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list gateways: %w", err)
	}
	return formatUnstructuredList(list), nil
}

// GetAllGateways lists gateways across all namespaces.
func (s *Service) GetAllGateways(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gateways")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all gateways: %w", err)
	}
	return formatUnstructuredList(list), nil
}

// DescribeGateway returns detailed info about a gateway.
func (s *Service) DescribeGateway(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "gateways")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get gateway %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":       obj.GetName(),
		"namespace":  obj.GetNamespace(),
		"labels":     obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at": toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		result["gateway_class_name"] = mapStr(spec, "gatewayClassName")

		listeners := mapSlice(spec, "listeners")
		listenerList := make([]map[string]interface{}, 0, len(listeners))
		for _, l := range listeners {
			if lm, ok := l.(map[string]interface{}); ok {
				listener := map[string]interface{}{
					"name":     mapStr(lm, "name"),
					"hostname": mapStr(lm, "hostname"),
					"port":     lm["port"],
					"protocol": mapStr(lm, "protocol"),
				}
				if tls := mapMap(lm, "tls"); tls != nil {
					listener["tls"] = tls
				}
				if allowed := mapMap(lm, "allowedRoutes"); allowed != nil {
					listener["allowed_routes"] = allowed
				}
				listenerList = append(listenerList, listener)
			}
		}
		result["listeners"] = listenerList
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

		addresses := mapSlice(status, "addresses")
		addrList := make([]map[string]interface{}, 0, len(addresses))
		for _, a := range addresses {
			if am, ok := a.(map[string]interface{}); ok {
				addrList = append(addrList, map[string]interface{}{
					"type":  mapStr(am, "type"),
					"value": mapStr(am, "value"),
				})
			}
		}
		result["addresses"] = addrList

		listenerStatuses := mapSlice(status, "listeners")
		lsList := make([]map[string]interface{}, 0, len(listenerStatuses))
		for _, ls := range listenerStatuses {
			if lsm, ok := ls.(map[string]interface{}); ok {
				lsEntry := map[string]interface{}{
					"name":            mapStr(lsm, "name"),
					"attached_routes": lsm["attachedRoutes"],
				}
				lsConds := mapSlice(lsm, "conditions")
				lsCondList := make([]map[string]interface{}, 0, len(lsConds))
				for _, c := range lsConds {
					if cm, ok := c.(map[string]interface{}); ok {
						lsCondList = append(lsCondList, map[string]interface{}{
							"type":    mapStr(cm, "type"),
							"status":  mapStr(cm, "status"),
							"reason":  mapStr(cm, "reason"),
							"message": mapStr(cm, "message"),
						})
					}
				}
				lsEntry["conditions"] = lsCondList
				lsList = append(lsList, lsEntry)
			}
		}
		result["listener_statuses"] = lsList
	}

	return result, nil
}

// DeleteGateway deletes a gateway.
func (s *Service) DeleteGateway(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "gateways")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
