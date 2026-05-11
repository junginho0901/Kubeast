package k8s

import (
	"context"
	"fmt"

	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== EndpointSlices ==========

// GetEndpointSlices lists endpoint slices in a namespace.
func (s *Service) GetEndpointSlices(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list endpoint slices: %w", err)
	}
	return formatEndpointSliceList(list.Items), nil
}

// GetAllEndpointSlices lists endpoint slices across all namespaces.
func (s *Service) GetAllEndpointSlices(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().DiscoveryV1().EndpointSlices("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all endpoint slices: %w", err)
	}
	return formatEndpointSliceList(list.Items), nil
}

// DescribeEndpointSlice returns detailed info about an endpoint slice.
func (s *Service) DescribeEndpointSlice(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	es, err := s.Clientset().DiscoveryV1().EndpointSlices(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get endpoint slice %s/%s: %w", namespace, name, err)
	}

	result := formatEndpointSliceDetail(es)
	result["labels"] = es.Labels
	result["annotations"] = es.Annotations

	endpoints := make([]map[string]interface{}, 0, len(es.Endpoints))
	for _, ep := range es.Endpoints {
		e := map[string]interface{}{
			"addresses": ep.Addresses,
		}
		// Conditions as nested object (frontend expects ep.conditions.ready)
		conditions := map[string]interface{}{}
		if ep.Conditions.Ready != nil {
			conditions["ready"] = *ep.Conditions.Ready
		}
		if ep.Conditions.Serving != nil {
			conditions["serving"] = *ep.Conditions.Serving
		}
		if ep.Conditions.Terminating != nil {
			conditions["terminating"] = *ep.Conditions.Terminating
		}
		e["conditions"] = conditions
		if ep.Hostname != nil {
			e["hostname"] = *ep.Hostname
		}
		if ep.TargetRef != nil {
			e["target_ref"] = map[string]interface{}{
				"kind":      ep.TargetRef.Kind,
				"name":      ep.TargetRef.Name,
				"namespace": ep.TargetRef.Namespace,
			}
		}
		if ep.NodeName != nil {
			e["node_name"] = *ep.NodeName
		}
		if ep.Zone != nil {
			e["zone"] = *ep.Zone
		}
		endpoints = append(endpoints, e)
	}
	result["endpoints"] = endpoints

	ports := make([]map[string]interface{}, 0, len(es.Ports))
	for _, p := range es.Ports {
		port := map[string]interface{}{}
		if p.Name != nil {
			port["name"] = *p.Name
		}
		if p.Port != nil {
			port["port"] = *p.Port
		}
		if p.Protocol != nil {
			port["protocol"] = string(*p.Protocol)
		}
		ports = append(ports, port)
	}
	result["ports"] = ports

	return result, nil
}

// DeleteEndpointSlice deletes an endpoint slice.
func (s *Service) DeleteEndpointSlice(ctx context.Context, namespace, name string) error {
	return s.Clientset().DiscoveryV1().EndpointSlices(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatEndpointSliceList(items []discoveryv1.EndpointSlice) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, es := range items {
		result = append(result, formatEndpointSliceDetail(&es))
	}
	return result
}

func formatEndpointSliceDetail(es *discoveryv1.EndpointSlice) map[string]interface{} {
	endpointsTotal := len(es.Endpoints)
	endpointsReady := 0
	endpointsNotReady := 0
	for _, ep := range es.Endpoints {
		if ep.Conditions.Ready != nil && *ep.Conditions.Ready {
			endpointsReady++
		} else {
			endpointsNotReady++
		}
	}

	// Extract ports with deduplication
	portSet := make(map[string]bool)
	ports := make([]map[string]interface{}, 0, len(es.Ports))
	for _, p := range es.Ports {
		name := ""
		if p.Name != nil {
			name = *p.Name
		}
		port := int32(0)
		if p.Port != nil {
			port = *p.Port
		}
		protocol := ""
		if p.Protocol != nil {
			protocol = string(*p.Protocol)
		}
		key := fmt.Sprintf("%s/%d/%s", name, port, protocol)
		if !portSet[key] {
			portSet[key] = true
			pm := map[string]interface{}{
				"name":     name,
				"port":     port,
				"protocol": protocol,
			}
			if p.AppProtocol != nil {
				pm["app_protocol"] = *p.AppProtocol
			}
			ports = append(ports, pm)
		}
	}

	serviceName := ""
	if es.Labels != nil {
		serviceName = es.Labels["kubernetes.io/service-name"]
	}
	managedBy := ""
	if es.Labels != nil {
		managedBy = es.Labels["endpointslice.kubernetes.io/managed-by"]
	}

	return map[string]interface{}{
		"name":                es.Name,
		"namespace":           es.Namespace,
		"service_name":        serviceName,
		"managed_by":          managedBy,
		"address_type":        string(es.AddressType),
		"endpoints_total":     endpointsTotal,
		"endpoints_ready":     endpointsReady,
		"endpoints_not_ready": endpointsNotReady,
		"ports":               ports,
		"created_at":          toISO(&es.CreationTimestamp),
	}
}
