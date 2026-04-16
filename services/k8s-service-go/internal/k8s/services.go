package k8s

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetServices lists services in a namespace.
func (s *Service) GetServices(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	svcList, err := s.Clientset().CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}
	return formatServiceList(svcList.Items), nil
}

// GetAllServices lists services across all namespaces.
func (s *Service) GetAllServices(ctx context.Context) ([]map[string]interface{}, error) {
	svcList, err := s.Clientset().CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all services: %w", err)
	}
	return formatServiceList(svcList.Items), nil
}

// DescribeService returns detailed info about a service.
func (s *Service) DescribeService(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	// Fetch service, endpoints, endpoint slices, and events in parallel
	var svc *corev1.Service
	var ep *corev1.Endpoints
	var esList *discoveryv1.EndpointSliceList
	var events *corev1.EventList
	var svcErr, epErr, esErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(4)
	go func() {
		defer wg.Done()
		svc, svcErr = s.Clientset().CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		ep, epErr = s.Clientset().CoreV1().Endpoints(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		esList, esErr = s.Clientset().DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{
			LabelSelector: fmt.Sprintf("kubernetes.io/service-name=%s", name),
		})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Service", name),
		})
	}()
	wg.Wait()

	if svcErr != nil {
		return nil, fmt.Errorf("get service %s/%s: %w", namespace, name, svcErr)
	}

	result := formatServiceDetail(svc)

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
			"status":              string(c.Status),
			"reason":              c.Reason,
			"message":             c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Endpoint summary
	if epErr == nil {
		readyCount := 0
		notReadyCount := 0
		readyAddresses := make([]string, 0)
		notReadyAddresses := make([]string, 0)
		for _, subset := range ep.Subsets {
			readyCount += len(subset.Addresses)
			notReadyCount += len(subset.NotReadyAddresses)
			for _, addr := range subset.Addresses {
				readyAddresses = append(readyAddresses, addr.IP)
			}
			for _, addr := range subset.NotReadyAddresses {
				notReadyAddresses = append(notReadyAddresses, addr.IP)
			}
		}
		result["endpoint_summary"] = map[string]interface{}{
			"ready_count":         readyCount,
			"not_ready_count":     notReadyCount,
			"ready_addresses":     readyAddresses,
			"not_ready_addresses": notReadyAddresses,
		}

		// Detailed endpoints list
		endpoints := make([]map[string]interface{}, 0)
		for _, subset := range ep.Subsets {
			ports := make([]map[string]interface{}, 0, len(subset.Ports))
			for _, p := range subset.Ports {
				ports = append(ports, map[string]interface{}{
					"name":     p.Name,
					"port":     p.Port,
					"protocol": string(p.Protocol),
				})
			}
			for _, addr := range subset.Addresses {
				entry := map[string]interface{}{
					"ip":    addr.IP,
					"ports": ports,
					"ready": true,
				}
				if addr.TargetRef != nil {
					entry["target_ref"] = map[string]interface{}{
						"kind":      addr.TargetRef.Kind,
						"name":      addr.TargetRef.Name,
						"namespace": addr.TargetRef.Namespace,
					}
				}
				endpoints = append(endpoints, entry)
			}
			for _, addr := range subset.NotReadyAddresses {
				entry := map[string]interface{}{
					"ip":    addr.IP,
					"ports": ports,
					"ready": false,
				}
				if addr.TargetRef != nil {
					entry["target_ref"] = map[string]interface{}{
						"kind":      addr.TargetRef.Kind,
						"name":      addr.TargetRef.Name,
						"namespace": addr.TargetRef.Namespace,
					}
				}
				endpoints = append(endpoints, entry)
			}
		}
		result["endpoints"] = endpoints
	} else {
		result["endpoints"] = []map[string]interface{}{}
	}

	// Endpoint slices (new - matching Python)
	if esErr == nil && esList != nil {
		endpointSlices := make([]map[string]interface{}, 0, len(esList.Items))
		for _, es := range esList.Items {
			endpointSlices = append(endpointSlices, formatEndpointSliceDetail(&es))
		}
		result["endpoint_slices"] = endpointSlices
	} else {
		result["endpoint_slices"] = []map[string]interface{}{}
	}

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		eventList := make([]map[string]interface{}, 0, len(events.Items))
		for _, e := range events.Items {
			eventList = append(eventList, map[string]interface{}{
				"type":       e.Type,
				"reason":     e.Reason,
				"message":    e.Message,
				"count":      e.Count,
				"first_time": toISO(&e.FirstTimestamp),
				"last_time":  toISO(&e.LastTimestamp),
			})
		}
		result["events"] = eventList
	}

	result["labels"] = svc.Labels
	result["annotations"] = svc.Annotations

	return result, nil
}

// DeleteService deletes a service.
func (s *Service) DeleteService(ctx context.Context, namespace, name string) error {
	return s.Clientset().CoreV1().Services(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// CheckServiceConnectivity performs a basic connectivity check on a service.
func (s *Service) CheckServiceConnectivity(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	svc, err := s.Clientset().CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get service %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":      name,
		"namespace": namespace,
		"type":      string(svc.Spec.Type),
	}

	// Check if endpoints exist
	ep, err := s.Clientset().CoreV1().Endpoints(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		result["has_endpoints"] = false
		result["connectivity"] = "no_endpoints"
		result["message"] = "service has no endpoints object"
		return result, nil
	}

	readyAddresses := 0
	for _, subset := range ep.Subsets {
		readyAddresses += len(subset.Addresses)
	}

	result["has_endpoints"] = readyAddresses > 0
	result["ready_endpoints"] = readyAddresses

	if readyAddresses == 0 {
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
	for _, svc := range services {
		result = append(result, formatServiceDetail(&svc))
	}
	return result
}

// formatServiceDetail formats a single service.
func formatServiceDetail(svc *corev1.Service) map[string]interface{} {
	ports := make([]map[string]interface{}, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		port := map[string]interface{}{
			"name":        p.Name,
			"port":        p.Port,
			"target_port": p.TargetPort.String(),
			"protocol":    string(p.Protocol),
		}
		if p.NodePort > 0 {
			port["node_port"] = p.NodePort
		}
		if p.AppProtocol != nil {
			port["app_protocol"] = *p.AppProtocol
		}
		ports = append(ports, port)
	}

	externalIPs := make([]string, 0)
	for _, ip := range svc.Spec.ExternalIPs {
		externalIPs = append(externalIPs, ip)
	}
	if svc.Spec.Type == corev1.ServiceTypeLoadBalancer {
		for _, ing := range svc.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				externalIPs = append(externalIPs, ing.IP)
			}
			if ing.Hostname != "" {
				externalIPs = append(externalIPs, ing.Hostname)
			}
		}
	}

	externalIP := "<none>"
	if len(externalIPs) > 0 {
		externalIP = strings.Join(externalIPs, ",")
	}

	return map[string]interface{}{
		"name":        svc.Name,
		"namespace":   svc.Namespace,
		"type":        string(svc.Spec.Type),
		"cluster_ip":  svc.Spec.ClusterIP,
		"external_ip": externalIP,
		"ports":       ports,
		"selector":    svc.Spec.Selector,
		"created_at":  toISO(&svc.CreationTimestamp),
	}
}
