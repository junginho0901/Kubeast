package k8s

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== Endpoints ==========

// GetEndpoints lists endpoints in a namespace.
func (s *Service) GetEndpoints(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().Endpoints(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list endpoints: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ep := range list.Items {
		result = append(result, formatEndpointsFull(&ep))
	}
	return result, nil
}

// GetAllEndpoints lists endpoints across all namespaces.
func (s *Service) GetAllEndpoints(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().Endpoints("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all endpoints: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ep := range list.Items {
		result = append(result, formatEndpointsFull(&ep))
	}
	return result, nil
}

// DescribeEndpoints returns detailed info about an endpoints resource.
func (s *Service) DescribeEndpoints(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	ep, err := s.Clientset().CoreV1().Endpoints(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get endpoints %s/%s: %w", namespace, name, err)
	}

	result := formatEndpointsFull(ep)
	result["labels"] = ep.Labels
	result["annotations"] = ep.Annotations

	// Also include raw subsets for detailed view
	subsets := make([]map[string]interface{}, 0, len(ep.Subsets))
	for _, subset := range ep.Subsets {
		ports := make([]map[string]interface{}, 0, len(subset.Ports))
		for _, p := range subset.Ports {
			ports = append(ports, map[string]interface{}{
				"name":     p.Name,
				"port":     p.Port,
				"protocol": string(p.Protocol),
			})
		}

		addresses := make([]map[string]interface{}, 0, len(subset.Addresses))
		for _, addr := range subset.Addresses {
			a := map[string]interface{}{"ip": addr.IP}
			if addr.TargetRef != nil {
				a["target_ref"] = map[string]interface{}{
					"kind":      addr.TargetRef.Kind,
					"name":      addr.TargetRef.Name,
					"namespace": addr.TargetRef.Namespace,
				}
			}
			addresses = append(addresses, a)
		}

		notReady := make([]map[string]interface{}, 0, len(subset.NotReadyAddresses))
		for _, addr := range subset.NotReadyAddresses {
			a := map[string]interface{}{"ip": addr.IP}
			if addr.TargetRef != nil {
				a["target_ref"] = map[string]interface{}{
					"kind":      addr.TargetRef.Kind,
					"name":      addr.TargetRef.Name,
					"namespace": addr.TargetRef.Namespace,
				}
			}
			notReady = append(notReady, a)
		}

		subsets = append(subsets, map[string]interface{}{
			"addresses":           addresses,
			"not_ready_addresses": notReady,
			"ports":               ports,
		})
	}
	result["subsets"] = subsets

	return result, nil
}

// DeleteEndpoints deletes an endpoints resource.
func (s *Service) DeleteEndpoints(ctx context.Context, namespace, name string) error {
	return s.Clientset().CoreV1().Endpoints(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatEndpointsBasic(name, namespace string, ts *metav1.Time, subsets int) map[string]interface{} {
	return map[string]interface{}{
		"name":         name,
		"namespace":    namespace,
		"subset_count": subsets,
		"created_at":   toISO(ts),
	}
}

func formatEndpointsFull(ep *corev1.Endpoints) map[string]interface{} {
	readyCount := 0
	notReadyCount := 0
	readyAddresses := make([]string, 0)
	notReadyAddresses := make([]string, 0)
	readyTargets := make([]map[string]interface{}, 0)
	notReadyTargets := make([]map[string]interface{}, 0)
	portSet := make(map[string]bool)
	ports := make([]map[string]interface{}, 0)

	for _, subset := range ep.Subsets {
		readyCount += len(subset.Addresses)
		notReadyCount += len(subset.NotReadyAddresses)

		for _, addr := range subset.Addresses {
			if len(readyAddresses) < 50 {
				readyAddresses = append(readyAddresses, addr.IP)
			}
			target := map[string]interface{}{"ip": addr.IP}
			if addr.NodeName != nil {
				target["node_name"] = *addr.NodeName
			}
			if addr.TargetRef != nil {
				target["target_ref"] = map[string]interface{}{
					"kind": addr.TargetRef.Kind,
					"name": addr.TargetRef.Name,
				}
			}
			readyTargets = append(readyTargets, target)
		}

		for _, addr := range subset.NotReadyAddresses {
			if len(notReadyAddresses) < 50 {
				notReadyAddresses = append(notReadyAddresses, addr.IP)
			}
			target := map[string]interface{}{"ip": addr.IP}
			if addr.NodeName != nil {
				target["node_name"] = *addr.NodeName
			}
			if addr.TargetRef != nil {
				target["target_ref"] = map[string]interface{}{
					"kind": addr.TargetRef.Kind,
					"name": addr.TargetRef.Name,
				}
			}
			notReadyTargets = append(notReadyTargets, target)
		}

		for _, p := range subset.Ports {
			key := fmt.Sprintf("%s/%d/%s", p.Name, p.Port, string(p.Protocol))
			if !portSet[key] {
				portSet[key] = true
				ports = append(ports, map[string]interface{}{
					"name":     p.Name,
					"port":     p.Port,
					"protocol": string(p.Protocol),
				})
			}
		}
	}

	return map[string]interface{}{
		"name":                ep.Name,
		"namespace":           ep.Namespace,
		"ready_count":         readyCount,
		"not_ready_count":     notReadyCount,
		"ready_addresses":     readyAddresses,
		"not_ready_addresses": notReadyAddresses,
		"ready_targets":       readyTargets,
		"not_ready_targets":   notReadyTargets,
		"ports":               ports,
		"created_at":          toISO(&ep.CreationTimestamp),
	}
}
