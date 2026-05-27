package k8s

import (
	"context"
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
	_, err := s.Dynamic().Resource(gvr).List(ctx, metav1.ListOptions{Limit: 1})
	if err == nil {
		s.gatewayAPIVersionCache = "v1"
		slog.Info("gateway API version detected", "version", "v1")
		return "v1"
	}

	// Fall back to v1beta1
	gvr.Version = "v1beta1"
	_, err = s.Dynamic().Resource(gvr).List(ctx, metav1.ListOptions{Limit: 1})
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

func (s *Service) gatewayPolicyGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	// Policy resources use v1alpha3 or v1alpha2, not the core gateway API version.
	// Try v1alpha3 first, then v1alpha2.
	for _, v := range []string{"v1alpha3", "v1alpha2"} {
		gvr := schema.GroupVersionResource{
			Group:    "gateway.networking.k8s.io",
			Version:  v,
			Resource: resource,
		}
		_, err := s.Dynamic().Resource(gvr).List(ctx, metav1.ListOptions{Limit: 1})
		if err == nil {
			return gvr
		}
	}
	// Default to v1alpha3
	return schema.GroupVersionResource{
		Group:    "gateway.networking.k8s.io",
		Version:  "v1alpha3",
		Resource: resource,
	}
}

func formatPolicyList(list *unstructured.UnstructuredList) []map[string]interface{} {
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
			targetRefs := mapSlice(spec, "targetRefs")
			if len(targetRefs) == 0 {
				if tr := mapMap(spec, "targetRef"); tr != nil {
					targetRefs = []interface{}{tr}
				}
			}
			refs := make([]map[string]interface{}, 0, len(targetRefs))
			for _, tr := range targetRefs {
				if tm, ok := tr.(map[string]interface{}); ok {
					ref := map[string]interface{}{
						"name": mapStr(tm, "name"),
					}
					if v := mapStr(tm, "group"); v != "" {
						ref["group"] = v
					}
					if v := mapStr(tm, "kind"); v != "" {
						ref["kind"] = v
					}
					if v := mapStr(tm, "namespace"); v != "" {
						ref["namespace"] = v
					}
					refs = append(refs, ref)
				}
			}
			entry["target_refs"] = refs
		}

		status := mapMap(item.Object, "status")
		if status != nil {
			ancestors := mapSlice(status, "ancestors")
			for _, a := range ancestors {
				if am, ok := a.(map[string]interface{}); ok {
					conditions := mapSlice(am, "conditions")
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
					if len(condList) > 0 {
						entry["conditions"] = condList
						break
					}
				}
			}
		}

		result = append(result, entry)
	}
	return result
}

func formatReferenceGrantList(list *unstructured.UnstructuredList) []map[string]interface{} {
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
			from := mapSlice(spec, "from")
			fromList := make([]map[string]interface{}, 0, len(from))
			for _, f := range from {
				if fm, ok := f.(map[string]interface{}); ok {
					fromList = append(fromList, map[string]interface{}{
						"group":     mapStr(fm, "group"),
						"kind":      mapStr(fm, "kind"),
						"namespace": mapStr(fm, "namespace"),
					})
				}
			}
			entry["from"] = fromList

			to := mapSlice(spec, "to")
			toList := make([]map[string]interface{}, 0, len(to))
			for _, t := range to {
				if tm, ok := t.(map[string]interface{}); ok {
					toList = append(toList, map[string]interface{}{
						"group": mapStr(tm, "group"),
						"kind":  mapStr(tm, "kind"),
						"name":  mapStr(tm, "name"),
					})
				}
			}
			entry["to"] = toList
		}

		result = append(result, entry)
	}
	return result
}

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
