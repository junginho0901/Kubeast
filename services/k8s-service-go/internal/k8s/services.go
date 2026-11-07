package k8s

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/endpointslice"
	servicerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/service"
)

// GetServices lists services in a namespace.
func (s *Service) GetServices(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	svcList, err := s.clientsetCtx(ctx).CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}
	return formatServiceList(svcList.Items), nil
}

// GetAllServices lists services across all namespaces.
func (s *Service) GetAllServices(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		svcList, err := s.clientsetCtx(ctx).CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all services: %w", err)
		}
		return formatServiceList(svcList.Items), nil
	})
}

// DescribeService returns detailed info about a service.
func (s *Service) DescribeService(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	// Fetch service, endpoint slices, and events in parallel
	var svc *corev1.Service
	var slices []discoveryv1.EndpointSlice
	var events *corev1.EventList
	var svcErr, esErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		svc, svcErr = s.clientsetCtx(ctx).CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		slices, esErr = s.serviceEndpointSlices(ctx, namespace, name)
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Service", name),
		})
	}()
	wg.Wait()

	if svcErr != nil {
		return nil, fmt.Errorf("get service %s/%s: %w", namespace, name, svcErr)
	}

	result := servicerow.Info(svc)

	// Additional describe fields
	result["uid"] = string(svc.UID)
	result["resource_version"] = svc.ResourceVersion
	result["cluster_ips"] = svc.Spec.ClusterIPs
	result["session_affinity"] = string(svc.Spec.SessionAffinity)
	if svc.Spec.SessionAffinityConfig != nil && svc.Spec.SessionAffinityConfig.ClientIP != nil && svc.Spec.SessionAffinityConfig.ClientIP.TimeoutSeconds != nil {
		result["session_affinity_timeout_seconds"] = *svc.Spec.SessionAffinityConfig.ClientIP.TimeoutSeconds
	}
	if svc.Spec.InternalTrafficPolicy != nil {
		result["internal_traffic_policy"] = string(*svc.Spec.InternalTrafficPolicy)
	}
	if svc.Spec.ExternalTrafficPolicy != "" {
		result["external_traffic_policy"] = string(svc.Spec.ExternalTrafficPolicy)
	}
	if svc.Spec.ExternalName != "" {
		result["external_name"] = svc.Spec.ExternalName
	}
	if len(svc.Spec.ExternalIPs) > 0 {
		result["external_ips"] = svc.Spec.ExternalIPs
	}
	if svc.Spec.IPFamilyPolicy != nil {
		result["ip_family_policy"] = string(*svc.Spec.IPFamilyPolicy)
	}
	ipFamilies := make([]string, 0, len(svc.Spec.IPFamilies))
	for _, f := range svc.Spec.IPFamilies {
		ipFamilies = append(ipFamilies, string(f))
	}
	result["ip_families"] = ipFamilies
	if svc.Spec.AllocateLoadBalancerNodePorts != nil {
		result["allocate_load_balancer_node_ports"] = *svc.Spec.AllocateLoadBalancerNodePorts
	}
	result["publish_not_ready_addresses"] = svc.Spec.PublishNotReadyAddresses
	if svc.Spec.HealthCheckNodePort > 0 {
		result["health_check_node_port"] = svc.Spec.HealthCheckNodePort
	}
	result["finalizers"] = svc.Finalizers

	// Owner references
	owners := make([]map[string]interface{}, 0, len(svc.OwnerReferences))
	for _, or := range svc.OwnerReferences {
		owners = append(owners, map[string]interface{}{
			"kind": or.Kind,
			"name": or.Name,
			"uid":  string(or.UID),
		})
	}
	result["owner_references"] = owners

	// Load balancer ingress
	lbIngress := make([]map[string]interface{}, 0)
	for _, ing := range svc.Status.LoadBalancer.Ingress {
		entry := map[string]interface{}{}
		if ing.IP != "" {
			entry["ip"] = ing.IP
		}
		if ing.Hostname != "" {
			entry["hostname"] = ing.Hostname
		}
		lbIngress = append(lbIngress, entry)
	}
	result["load_balancer_ingress"] = lbIngress

	// Conditions
	conditions := make([]map[string]interface{}, 0)
	for _, c := range svc.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Endpoint summary and the address list, both from the slices
	if esErr == nil {
		ready, notReady := readyAddresses(slices)
		result["endpoint_summary"] = map[string]interface{}{
			"ready_count":         len(ready),
			"not_ready_count":     len(notReady),
			"ready_addresses":     ready,
			"not_ready_addresses": notReady,
		}
		result["endpoints"] = sliceAddresses(slices)
	} else {
		result["endpoints"] = []map[string]interface{}{}
	}

	// Endpoint slices
	if esErr == nil {
		endpointSlices := make([]map[string]interface{}, 0, len(slices))
		for i := range slices {
			endpointSlices = append(endpointSlices, endpointslice.Info(&slices[i]))
		}
		result["endpoint_slices"] = endpointSlices
	} else {
		result["endpoint_slices"] = []map[string]interface{}{}
	}

	// Events
	setEvents(result, events, eventsErr)

	result["labels"] = svc.Labels
	result["annotations"] = svc.Annotations

	return result, nil
}

// DeleteService deletes a service.
func (s *Service) DeleteService(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).CoreV1().Services(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// CheckServiceConnectivity performs a basic connectivity check on a service.
func (s *Service) CheckServiceConnectivity(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	svc, err := s.clientsetCtx(ctx).CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get service %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":      name,
		"namespace": namespace,
		"type":      string(svc.Spec.Type),
	}

	// The Service's EndpointSlices say whether anything backs it.
	slices, err := s.serviceEndpointSlices(ctx, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("list endpointslices of %s/%s: %w", namespace, name, err)
	}
	if len(slices) == 0 {
		result["has_endpoints"] = false
		result["connectivity"] = "no_endpoints"
		result["message"] = "service has no EndpointSlices"
		return result, nil
	}

	ready, _ := readyAddresses(slices)
	readyCount := len(ready)

	result["has_endpoints"] = readyCount > 0
	result["ready_endpoints"] = readyCount

	if readyCount == 0 {
		result["connectivity"] = "no_ready_endpoints"
		result["message"] = "service exists but has no ready endpoints"
		return result, nil
	}

	// Try TCP connect to cluster IP if available
	if svc.Spec.ClusterIP != "" && svc.Spec.ClusterIP != "None" && len(svc.Spec.Ports) > 0 {
		addr := net.JoinHostPort(svc.Spec.ClusterIP, fmt.Sprintf("%d", svc.Spec.Ports[0].Port))
		conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err != nil {
			result["connectivity"] = "tcp_failed"
			result["message"] = fmt.Sprintf("TCP connect to %s failed: %v", addr, err)
		} else {
			conn.Close()
			result["connectivity"] = "ok"
			result["message"] = fmt.Sprintf("TCP connect to %s succeeded", addr)
		}
	} else {
		result["connectivity"] = "headless_or_no_ports"
		result["message"] = "service is headless or has no ports; endpoints exist"
	}

	return result, nil
}

// formatServiceList formats a list of services.
func formatServiceList(services []corev1.Service) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(services))
	for i := range services {
		result = append(result, servicerow.Info(&services[i]))
	}
	return result
}
