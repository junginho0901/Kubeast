package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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
