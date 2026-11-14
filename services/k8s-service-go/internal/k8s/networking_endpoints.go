package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	endpointsrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpoints"
)

// ========== Endpoints ==========

// GetEndpoints lists endpoints in a namespace.
func (s *Service) GetEndpoints(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).CoreV1().Endpoints(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list endpoints: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ep := range list.Items {
		result = append(result, endpointsrow.Info(&ep))
	}
	return result, nil
}

// GetAllEndpoints lists endpoints across all namespaces.
func (s *Service) GetAllEndpoints(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).CoreV1().Endpoints(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all endpoints: %w", err)
		}
		result := make([]map[string]interface{}, 0, len(list.Items))
		for _, ep := range list.Items {
			result = append(result, endpointsrow.Info(&ep))
		}
		return result, nil
	})
}

// DescribeEndpoints returns the list's row of an Endpoints with what kubectl describe adds: the metadata, each
// subset's ready and not-ready addresses and ports, and the events. The drawer reads it however it was opened.
func (s *Service) DescribeEndpoints(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ep *corev1.Endpoints
	var events *corev1.EventList
	var epErr, eventsErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		ep, epErr = s.clientsetCtx(ctx).CoreV1().Endpoints(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.objectEvents(ctx, namespace, "Endpoints", name)
	}()
	wg.Wait()
	if epErr != nil {
		return nil, fmt.Errorf("get endpoints %s/%s: %w", namespace, name, epErr)
	}

	result := endpointsrow.Info(ep)
	result["uid"] = string(ep.UID)
	result["labels"] = ep.Labels
	result["annotations"] = ep.Annotations
	result["generation"] = ep.Generation
	result["resource_version"] = ep.ResourceVersion
	setEvents(result, events, eventsErr, about(ep.UID))

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
	return s.clientsetCtx(ctx).CoreV1().Endpoints(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
