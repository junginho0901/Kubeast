package k8s

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const gatewayAPIGroup = "gateway.networking.k8s.io"

// addObjectMetaFields adds the ObjectMeta values the detail drawers' Lifecycle
// section reads (the same keys the typed describe responses carry).
func addObjectMetaFields(result map[string]interface{}, obj *unstructured.Unstructured) {
	result["uid"] = string(obj.GetUID())
	result["resource_version"] = obj.GetResourceVersion()
	result["generation"] = obj.GetGeneration()
	if f := obj.GetFinalizers(); len(f) > 0 {
		result["finalizers"] = f
	}
}

// gatewayGVR is the GVR the cluster serves for one Gateway API resource. Each
// kind is resolved on its own because the group mixes versions (gateways v1,
// referencegrants v1beta1, backendtlspolicies v1alpha3). When the cluster has
// no Gateway API, the v1 GVR is returned so the list fails with "not found",
// which the handlers turn into an empty page.
func (s *Service) gatewayGVR(ctx context.Context, resource string) schema.GroupVersionResource {
	if gvr, ok := s.resolveGVR(ctx, gatewayAPIGroup, resource); ok {
		return gvr
	}
	return schema.GroupVersionResource{Group: gatewayAPIGroup, Version: "v1", Resource: resource}
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
