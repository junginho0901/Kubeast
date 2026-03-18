package k8s

import (
	"context"
	"fmt"
	"log/slog"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// resolveGatewayAPIVersion auto-detects whether the cluster uses v1 or v1beta1 for gateway.networking.k8s.io.
// The result is cached for the lifetime of the process.
func (s *Service) resolveGatewayAPIVersion(ctx context.Context) string {
	s.gatewayAPIVersionMu.RLock()
	cached := s.gatewayAPIVersionCache
	s.gatewayAPIVersionMu.RUnlock()
	if cached != "" {
		return cached
	}

	s.gatewayAPIVersionMu.Lock()
	defer s.gatewayAPIVersionMu.Unlock()

	// Double-check after acquiring write lock
	if s.gatewayAPIVersionCache != "" {
		return s.gatewayAPIVersionCache
	}

	// Try v1 first
	gvr := schema.GroupVersionResource{
		Group:    "gateway.networking.k8s.io",
		Version:  "v1",
		Resource: "gateways",
	}
	_, err := s.dynamic.Resource(gvr).List(ctx, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.gatewayAPIVersionCache = "v1"
		slog.Info("gateway API version detected", "version", "v1")
		return "v1"
	}

	// Fall back to v1beta1
	gvr.Version = "v1beta1"
	_, err = s.dynamic.Resource(gvr).List(ctx, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.gatewayAPIVersionCache = "v1beta1"
		slog.Info("gateway API version detected", "version", "v1beta1")
		return "v1beta1"
	}

	// Default to v1
	s.gatewayAPIVersionCache = "v1"
	slog.Warn("gateway API not detected, defaulting to v1")
	return "v1"
}

func (s *Service) gatewayGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	return schema.GroupVersionResource{
		Group:    "gateway.networking.k8s.io",
		Version:  s.resolveGatewayAPIVersion(ctx),
		Resource: resource,
	}
}

// ========== Gateways ==========

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

// ========== GatewayClasses ==========

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

// ========== HTTPRoutes ==========

// GetHTTPRoutes lists HTTP routes in a namespace.
func (s *Service) GetHTTPRoutes(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "httproutes")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list httproutes: %w", err)
	}
	return formatUnstructuredList(list), nil
}

// GetAllHTTPRoutes lists HTTP routes across all namespaces.
func (s *Service) GetAllHTTPRoutes(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "httproutes")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all httproutes: %w", err)
	}
	return formatUnstructuredList(list), nil
}

// DescribeHTTPRoute returns detailed info about an HTTP route.
func (s *Service) DescribeHTTPRoute(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "httproutes")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get httproute %s/%s: %w", namespace, name, err)
	}

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	spec := mapMap(obj.Object, "spec")
	if spec != nil {
		// Parent refs
		parentRefs := mapSlice(spec, "parentRefs")
		parents := make([]map[string]interface{}, 0, len(parentRefs))
		for _, pr := range parentRefs {
			if pm, ok := pr.(map[string]interface{}); ok {
				parent := map[string]interface{}{
					"name": mapStr(pm, "name"),
				}
				if v := mapStr(pm, "namespace"); v != "" {
					parent["namespace"] = v
				}
				if v := mapStr(pm, "sectionName"); v != "" {
					parent["section_name"] = v
				}
				if v := mapStr(pm, "group"); v != "" {
					parent["group"] = v
				}
				if v := mapStr(pm, "kind"); v != "" {
					parent["kind"] = v
				}
				parents = append(parents, parent)
			}
		}
		result["parent_refs"] = parents

		// Hostnames
		hostnames := mapSlice(spec, "hostnames")
		hn := make([]string, 0, len(hostnames))
		for _, h := range hostnames {
			if hs, ok := h.(string); ok {
				hn = append(hn, hs)
			}
		}
		result["hostnames"] = hn

		// Rules
		rules := mapSlice(spec, "rules")
		ruleList := make([]map[string]interface{}, 0, len(rules))
		for _, r := range rules {
			if rm, ok := r.(map[string]interface{}); ok {
				rule := map[string]interface{}{}

				// Matches
				matches := mapSlice(rm, "matches")
				matchList := make([]map[string]interface{}, 0, len(matches))
				for _, m := range matches {
					if mm, ok := m.(map[string]interface{}); ok {
						match := map[string]interface{}{}
						if path := mapMap(mm, "path"); path != nil {
							match["path"] = path
						}
						if headers := mapSlice(mm, "headers"); headers != nil {
							match["headers"] = headers
						}
						if qp := mapSlice(mm, "queryParams"); qp != nil {
							match["query_params"] = qp
						}
						if method := mapStr(mm, "method"); method != "" {
							match["method"] = method
						}
						matchList = append(matchList, match)
					}
				}
				rule["matches"] = matchList

				// Backend refs
				backendRefs := mapSlice(rm, "backendRefs")
				backends := make([]map[string]interface{}, 0, len(backendRefs))
				for _, br := range backendRefs {
					if bm, ok := br.(map[string]interface{}); ok {
						backend := map[string]interface{}{
							"name": mapStr(bm, "name"),
						}
						if v := bm["port"]; v != nil {
							backend["port"] = v
						}
						if v := bm["weight"]; v != nil {
							backend["weight"] = v
						}
						if v := mapStr(bm, "namespace"); v != "" {
							backend["namespace"] = v
						}
						if v := mapStr(bm, "group"); v != "" {
							backend["group"] = v
						}
						if v := mapStr(bm, "kind"); v != "" {
							backend["kind"] = v
						}
						backends = append(backends, backend)
					}
				}
				rule["backend_refs"] = backends

				// Filters
				filters := mapSlice(rm, "filters")
				if len(filters) > 0 {
					rule["filters"] = filters
				}

				ruleList = append(ruleList, rule)
			}
		}
		result["rules"] = ruleList
	}

	status := mapMap(obj.Object, "status")
	if status != nil {
		parents := mapSlice(status, "parents")
		parentStatuses := make([]map[string]interface{}, 0, len(parents))
		for _, p := range parents {
			if pm, ok := p.(map[string]interface{}); ok {
				ps := map[string]interface{}{}
				if parentRef := mapMap(pm, "parentRef"); parentRef != nil {
					ps["parent_ref"] = parentRef
				}
				conditions := mapSlice(pm, "conditions")
				condList := make([]map[string]interface{}, 0, len(conditions))
				for _, c := range conditions {
					if cm, ok := c.(map[string]interface{}); ok {
						condList = append(condList, map[string]interface{}{
							"type":    mapStr(cm, "type"),
							"status":  mapStr(cm, "status"),
							"reason":  mapStr(cm, "reason"),
							"message": mapStr(cm, "message"),
						})
					}
				}
				ps["conditions"] = condList
				parentStatuses = append(parentStatuses, ps)
			}
		}
		result["parent_statuses"] = parentStatuses
	}

	return result, nil
}

// DeleteHTTPRoute deletes an HTTP route.
func (s *Service) DeleteHTTPRoute(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "httproutes")
	return s.DeleteResource(ctx, gvr, namespace, name)
}

// ========== Helper ==========

func formatUnstructuredList(list *unstructured.UnstructuredList) []map[string]interface{} {
	if list == nil {
		return []map[string]interface{}{}
	}
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":       item.GetName(),
			"namespace":  item.GetNamespace(),
			"labels":     item.GetLabels(),
			"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		spec := mapMap(item.Object, "spec")
		if spec != nil {
			for _, key := range []string{"gatewayClassName", "controllerName", "description"} {
				if v := mapStr(spec, key); v != "" {
					entry[key] = v
				}
			}
			if hostnames := mapSlice(spec, "hostnames"); len(hostnames) > 0 {
				hn := make([]string, 0, len(hostnames))
				for _, h := range hostnames {
					if hs, ok := h.(string); ok {
						hn = append(hn, hs)
					}
				}
				entry["hostnames"] = hn
			}
			if parentRefs := mapSlice(spec, "parentRefs"); len(parentRefs) > 0 {
				parents := make([]map[string]interface{}, 0, len(parentRefs))
				for _, pr := range parentRefs {
					if pm, ok := pr.(map[string]interface{}); ok {
						parents = append(parents, pm)
					}
				}
				entry["parent_refs"] = parents
			}
			if listeners := mapSlice(spec, "listeners"); len(listeners) > 0 {
				entry["listener_count"] = len(listeners)
			}
		}

		status := mapMap(item.Object, "status")
		if status != nil {
			if conditions := mapSlice(status, "conditions"); len(conditions) > 0 {
				condList := make([]map[string]interface{}, 0, len(conditions))
				for _, c := range conditions {
					if cm, ok := c.(map[string]interface{}); ok {
						condList = append(condList, map[string]interface{}{
							"type":   mapStr(cm, "type"),
							"status": mapStr(cm, "status"),
							"reason": mapStr(cm, "reason"),
						})
					}
				}
				entry["conditions"] = condList
			}
		}

		result = append(result, entry)
	}
	return result
}
