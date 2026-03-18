package k8s

import (
	"context"
	"fmt"
	"sort"
	"sync"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== Ingresses ==========

// GetIngresses lists ingresses in a namespace.
func (s *Service) GetIngresses(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingresses: %w", err)
	}
	return formatIngressList(list.Items), nil
}

// GetAllIngresses lists ingresses across all namespaces.
func (s *Service) GetAllIngresses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all ingresses: %w", err)
	}
	return formatIngressList(list.Items), nil
}

// DescribeIngress returns detailed info about an ingress.
func (s *Service) DescribeIngress(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ing *networkingv1.Ingress
	var icList *networkingv1.IngressClassList
	var events *corev1.EventList
	var ingErr, icErr, eventsErr error

	wg.Add(3)
	go func() {
		defer wg.Done()
		ing, ingErr = s.clientset.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		icList, icErr = s.clientset.NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Ingress", name),
		})
	}()
	wg.Wait()

	if ingErr != nil {
		return nil, fmt.Errorf("get ingress %s/%s: %w", namespace, name, ingErr)
	}

	// formatIngressDetail now includes rules, tls, default_backend, labels, annotations
	result := formatIngressDetail(ing)

	// Try to enrich with IngressClass controller info
	if ing.Spec.IngressClassName != nil && icErr == nil {
		for i := range icList.Items {
			if icList.Items[i].Name == *ing.Spec.IngressClassName {
				ic := &icList.Items[i]
				result["class_controller"] = ic.Spec.Controller
				isDefault := false
				if v, ok := ic.Annotations["ingressclass.kubernetes.io/is-default-class"]; ok && v == "true" {
					isDefault = true
				}
				result["class_is_default"] = isDefault
				break
			}
		}
	}

	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteIngress deletes an ingress.
func (s *Service) DeleteIngress(ctx context.Context, namespace, name string) error {
	return s.clientset.NetworkingV1().Ingresses(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== IngressClasses ==========

// GetIngressClasses lists all ingress classes.
func (s *Service) GetIngressClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ingress classes: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, ic := range list.Items {
		result = append(result, formatIngressClassDetail(&ic))
	}
	return result, nil
}

// DescribeIngressClass returns detailed info about an ingress class.
func (s *Service) DescribeIngressClass(ctx context.Context, name string) (map[string]interface{}, error) {
	ic, err := s.clientset.NetworkingV1().IngressClasses().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get ingress class %s: %w", name, err)
	}
	result := formatIngressClassDetail(ic)
	result["labels"] = ic.Labels
	result["annotations"] = ic.Annotations
	if ic.Spec.Parameters != nil {
		params := map[string]interface{}{
			"kind": ic.Spec.Parameters.Kind,
			"name": ic.Spec.Parameters.Name,
		}
		if ic.Spec.Parameters.APIGroup != nil {
			params["api_group"] = *ic.Spec.Parameters.APIGroup
		}
		if ic.Spec.Parameters.Namespace != nil {
			params["namespace"] = *ic.Spec.Parameters.Namespace
		}
		if ic.Spec.Parameters.Scope != nil {
			params["scope"] = *ic.Spec.Parameters.Scope
		}
		result["parameters"] = params
	}
	return result, nil
}

// DeleteIngressClass deletes an ingress class.
func (s *Service) DeleteIngressClass(ctx context.Context, name string) error {
	return s.clientset.NetworkingV1().IngressClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Endpoints ==========

// GetEndpoints lists endpoints in a namespace.
func (s *Service) GetEndpoints(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.CoreV1().Endpoints(namespace).List(ctx, metav1.ListOptions{})
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
	list, err := s.clientset.CoreV1().Endpoints("").List(ctx, metav1.ListOptions{})
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
	ep, err := s.clientset.CoreV1().Endpoints(namespace).Get(ctx, name, metav1.GetOptions{})
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
	return s.clientset.CoreV1().Endpoints(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== EndpointSlices ==========

// GetEndpointSlices lists endpoint slices in a namespace.
func (s *Service) GetEndpointSlices(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list endpoint slices: %w", err)
	}
	return formatEndpointSliceList(list.Items), nil
}

// GetAllEndpointSlices lists endpoint slices across all namespaces.
func (s *Service) GetAllEndpointSlices(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.DiscoveryV1().EndpointSlices("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all endpoint slices: %w", err)
	}
	return formatEndpointSliceList(list.Items), nil
}

// DescribeEndpointSlice returns detailed info about an endpoint slice.
func (s *Service) DescribeEndpointSlice(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	es, err := s.clientset.DiscoveryV1().EndpointSlices(namespace).Get(ctx, name, metav1.GetOptions{})
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
		if ep.Conditions.Ready != nil {
			e["ready"] = *ep.Conditions.Ready
		}
		if ep.Conditions.Serving != nil {
			e["serving"] = *ep.Conditions.Serving
		}
		if ep.Conditions.Terminating != nil {
			e["terminating"] = *ep.Conditions.Terminating
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
	return s.clientset.DiscoveryV1().EndpointSlices(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== NetworkPolicies ==========

// GetNetworkPolicies lists network policies in a namespace.
func (s *Service) GetNetworkPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.NetworkingV1().NetworkPolicies(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list network policies: %w", err)
	}
	return formatNetworkPolicyList(list.Items), nil
}

// GetAllNetworkPolicies lists network policies across all namespaces.
func (s *Service) GetAllNetworkPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.NetworkingV1().NetworkPolicies("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all network policies: %w", err)
	}
	return formatNetworkPolicyList(list.Items), nil
}

// DescribeNetworkPolicy returns detailed info about a network policy.
func (s *Service) DescribeNetworkPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	np, err := s.clientset.NetworkingV1().NetworkPolicies(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get network policy %s/%s: %w", namespace, name, err)
	}

	// formatNetworkPolicyDetail already includes all fields
	result := formatNetworkPolicyDetail(np)
	result["finalizers"] = np.Finalizers
	return result, nil
}

// DeleteNetworkPolicy deletes a network policy.
func (s *Service) DeleteNetworkPolicy(ctx context.Context, namespace, name string) error {
	return s.clientset.NetworkingV1().NetworkPolicies(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Formatting helpers ==========

func formatIngressList(items []networkingv1.Ingress) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, ing := range items {
		result = append(result, formatIngressDetail(&ing))
	}
	return result
}

func formatIngressDetail(ing *networkingv1.Ingress) map[string]interface{} {
	hosts := make([]string, 0)
	backendSet := make(map[string]bool)
	backends := make([]string, 0)

	// Build rules with full detail
	rules := make([]map[string]interface{}, 0, len(ing.Spec.Rules))
	for _, rule := range ing.Spec.Rules {
		if rule.Host != "" {
			hosts = append(hosts, rule.Host)
		}
		r := map[string]interface{}{
			"host": rule.Host,
		}
		if rule.HTTP != nil {
			paths := make([]map[string]interface{}, 0, len(rule.HTTP.Paths))
			for _, p := range rule.HTTP.Paths {
				path := map[string]interface{}{
					"path": p.Path,
				}
				if p.PathType != nil {
					path["path_type"] = string(*p.PathType)
				}
				if p.Backend.Service != nil {
					svcName := p.Backend.Service.Name
					backend := map[string]interface{}{
						"service_name": svcName,
					}
					if p.Backend.Service.Port.Number > 0 {
						backend["service_port"] = p.Backend.Service.Port.Number
					}
					if p.Backend.Service.Port.Name != "" {
						backend["service_port_name"] = p.Backend.Service.Port.Name
					}
					path["backend"] = backend
					if !backendSet[svcName] {
						backendSet[svcName] = true
						backends = append(backends, svcName)
					}
				}
				paths = append(paths, path)
			}
			r["paths"] = paths
		}
		rules = append(rules, r)
	}
	sort.Strings(backends)

	addresses := make([]map[string]interface{}, 0)
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		addr := map[string]interface{}{}
		if lb.IP != "" {
			addr["ip"] = lb.IP
		}
		if lb.Hostname != "" {
			addr["hostname"] = lb.Hostname
		}
		addresses = append(addresses, addr)
	}

	ingressClass := ""
	classSource := ""
	if ing.Spec.IngressClassName != nil {
		ingressClass = *ing.Spec.IngressClassName
		classSource = "spec"
	} else if v, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok {
		ingressClass = v
		classSource = "annotation"
	}

	// TLS info
	tls := make([]map[string]interface{}, 0, len(ing.Spec.TLS))
	for _, t := range ing.Spec.TLS {
		tls = append(tls, map[string]interface{}{
			"secret_name": t.SecretName,
			"hosts":       t.Hosts,
		})
	}

	// Default backend
	var defaultBackend interface{}
	if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
		db := map[string]interface{}{
			"type":         "service",
			"service_name": ing.Spec.DefaultBackend.Service.Name,
		}
		if ing.Spec.DefaultBackend.Service.Port.Number > 0 {
			db["service_port"] = ing.Spec.DefaultBackend.Service.Port.Number
		}
		defaultBackend = db
	}

	return map[string]interface{}{
		"name":            ing.Name,
		"namespace":       ing.Namespace,
		"class":           ingressClass,
		"class_source":    classSource,
		"hosts":           hosts,
		"addresses":       addresses,
		"tls":             tls,
		"default_backend": defaultBackend,
		"rules":           rules,
		"backends":        backends,
		"labels":          ing.Labels,
		"annotations":     ing.Annotations,
		"created_at":      toISO(&ing.CreationTimestamp),
	}
}

func formatIngressClassDetail(ic *networkingv1.IngressClass) map[string]interface{} {
	isDefault := false
	if v, ok := ic.Annotations["ingressclass.kubernetes.io/is-default-class"]; ok && v == "true" {
		isDefault = true
	}

	result := map[string]interface{}{
		"name":        ic.Name,
		"controller":  ic.Spec.Controller,
		"is_default":  isDefault,
		"labels":      ic.Labels,
		"annotations": ic.Annotations,
		"finalizers":  ic.Finalizers,
		"created_at":  toISO(&ic.CreationTimestamp),
	}

	if ic.Spec.Parameters != nil {
		params := map[string]interface{}{
			"kind": ic.Spec.Parameters.Kind,
			"name": ic.Spec.Parameters.Name,
		}
		if ic.Spec.Parameters.APIGroup != nil {
			params["api_group"] = *ic.Spec.Parameters.APIGroup
		}
		if ic.Spec.Parameters.Namespace != nil {
			params["namespace"] = *ic.Spec.Parameters.Namespace
		}
		if ic.Spec.Parameters.Scope != nil {
			params["scope"] = *ic.Spec.Parameters.Scope
		}
		result["parameters"] = params
	}

	return result
}

func formatEndpointsBasic(name, namespace string, ts *metav1.Time, subsets int) map[string]interface{} {
	return map[string]interface{}{
		"name":          name,
		"namespace":     namespace,
		"subset_count":  subsets,
		"created_at":    toISO(ts),
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
		"name":               es.Name,
		"namespace":          es.Namespace,
		"service_name":       serviceName,
		"managed_by":         managedBy,
		"address_type":       string(es.AddressType),
		"endpoints_total":    endpointsTotal,
		"endpoints_ready":    endpointsReady,
		"endpoints_not_ready": endpointsNotReady,
		"ports":              ports,
		"created_at":         toISO(&es.CreationTimestamp),
	}
}

func formatNetworkPolicyList(items []networkingv1.NetworkPolicy) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, np := range items {
		result = append(result, formatNetworkPolicyDetail(&np))
	}
	return result
}

func formatNetworkPolicyDetail(np *networkingv1.NetworkPolicy) map[string]interface{} {
	policyTypes := make([]string, 0, len(np.Spec.PolicyTypes))
	for _, pt := range np.Spec.PolicyTypes {
		policyTypes = append(policyTypes, string(pt))
	}

	podSelector := map[string]interface{}{}
	if np.Spec.PodSelector.MatchLabels != nil {
		podSelector["match_labels"] = np.Spec.PodSelector.MatchLabels
	}
	if len(np.Spec.PodSelector.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0)
		for _, e := range np.Spec.PodSelector.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      e.Key,
				"operator": string(e.Operator),
				"values":   e.Values,
			})
		}
		podSelector["match_expressions"] = exprs
	}

	selectsAllPods := len(np.Spec.PodSelector.MatchLabels) == 0 && len(np.Spec.PodSelector.MatchExpressions) == 0

	// Check default deny
	defaultDenyIngress := false
	defaultDenyEgress := false
	for _, pt := range np.Spec.PolicyTypes {
		if pt == networkingv1.PolicyTypeIngress && len(np.Spec.Ingress) == 0 {
			defaultDenyIngress = true
		}
		if pt == networkingv1.PolicyTypeEgress && len(np.Spec.Egress) == 0 {
			defaultDenyEgress = true
		}
	}

	// Build ingress rules
	ingressRules := make([]map[string]interface{}, 0, len(np.Spec.Ingress))
	for _, rule := range np.Spec.Ingress {
		r := map[string]interface{}{}
		from := make([]map[string]interface{}, 0, len(rule.From))
		for _, f := range rule.From {
			peer := map[string]interface{}{}
			if f.PodSelector != nil {
				peer["pod_selector"] = f.PodSelector.MatchLabels
			}
			if f.NamespaceSelector != nil {
				peer["namespace_selector"] = f.NamespaceSelector.MatchLabels
			}
			if f.IPBlock != nil {
				ipBlock := map[string]interface{}{"cidr": f.IPBlock.CIDR}
				if len(f.IPBlock.Except) > 0 {
					ipBlock["except"] = f.IPBlock.Except
				}
				peer["ip_block"] = ipBlock
			}
			from = append(from, peer)
		}
		r["from"] = from
		ports := make([]map[string]interface{}, 0, len(rule.Ports))
		for _, p := range rule.Ports {
			port := map[string]interface{}{}
			if p.Protocol != nil {
				port["protocol"] = string(*p.Protocol)
			}
			if p.Port != nil {
				port["port"] = p.Port.String()
			}
			ports = append(ports, port)
		}
		r["ports"] = ports
		ingressRules = append(ingressRules, r)
	}

	// Build egress rules
	egressRules := make([]map[string]interface{}, 0, len(np.Spec.Egress))
	for _, rule := range np.Spec.Egress {
		r := map[string]interface{}{}
		to := make([]map[string]interface{}, 0, len(rule.To))
		for _, t := range rule.To {
			peer := map[string]interface{}{}
			if t.PodSelector != nil {
				peer["pod_selector"] = t.PodSelector.MatchLabels
			}
			if t.NamespaceSelector != nil {
				peer["namespace_selector"] = t.NamespaceSelector.MatchLabels
			}
			if t.IPBlock != nil {
				ipBlock := map[string]interface{}{"cidr": t.IPBlock.CIDR}
				if len(t.IPBlock.Except) > 0 {
					ipBlock["except"] = t.IPBlock.Except
				}
				peer["ip_block"] = ipBlock
			}
			to = append(to, peer)
		}
		r["to"] = to
		ports := make([]map[string]interface{}, 0, len(rule.Ports))
		for _, p := range rule.Ports {
			port := map[string]interface{}{}
			if p.Protocol != nil {
				port["protocol"] = string(*p.Protocol)
			}
			if p.Port != nil {
				port["port"] = p.Port.String()
			}
			ports = append(ports, port)
		}
		r["ports"] = ports
		egressRules = append(egressRules, r)
	}

	return map[string]interface{}{
		"name":                 np.Name,
		"namespace":            np.Namespace,
		"pod_selector":         podSelector,
		"selects_all_pods":     selectsAllPods,
		"policy_types":         policyTypes,
		"default_deny_ingress": defaultDenyIngress,
		"default_deny_egress":  defaultDenyEgress,
		"ingress_rules":        len(np.Spec.Ingress),
		"egress_rules":         len(np.Spec.Egress),
		"ingress":              ingressRules,
		"egress":               egressRules,
		"labels":               np.Labels,
		"annotations":          np.Annotations,
		"created_at":           toISO(&np.CreationTimestamp),
	}
}
