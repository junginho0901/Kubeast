package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetBackendTrafficPolicies lists BackendTrafficPolicies in a namespace.
func (s *Service) GetBackendTrafficPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtrafficpolicies")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list backendtrafficpolicies: %w", err)
	}
	return formatPolicyList(list), nil
}

// GetAllBackendTrafficPolicies lists BackendTrafficPolicies across all namespaces.
func (s *Service) GetAllBackendTrafficPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtrafficpolicies")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all backendtrafficpolicies: %w", err)
	}
	return formatPolicyList(list), nil
}

// DescribeBackendTrafficPolicy returns detailed info about a BackendTrafficPolicy.
func (s *Service) DescribeBackendTrafficPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	gvr := s.gatewayPolicyGVR(ctx, "backendtrafficpolicies")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get backendtrafficpolicy %s/%s: %w", namespace, name, err)
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
		// targetRefs
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
				if v := mapStr(tm, "sectionName"); v != "" {
					ref["section_name"] = v
				}
				refs = append(refs, ref)
			}
		}
		result["target_refs"] = refs

		// sessionPersistence
		if sp := mapMap(spec, "sessionPersistence"); sp != nil {
			result["session_persistence"] = sp
		}

		// retry
		if retry := mapMap(spec, "retry"); retry != nil {
			result["retry"] = retry
		}

		// rateLimit
		if rl := mapMap(spec, "rateLimit"); rl != nil {
			result["rate_limit"] = rl
		}
	}

	// status conditions
	status := mapMap(obj.Object, "status")
	if status != nil {
		ancestors := mapSlice(status, "ancestors")
		ancestorStatuses := make([]map[string]interface{}, 0, len(ancestors))
		for _, a := range ancestors {
			if am, ok := a.(map[string]interface{}); ok {
				as := map[string]interface{}{}
				if ancestorRef := mapMap(am, "ancestorRef"); ancestorRef != nil {
					as["ancestor_ref"] = ancestorRef
				}
				conditions := mapSlice(am, "conditions")
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
				as["conditions"] = condList
				ancestorStatuses = append(ancestorStatuses, as)
			}
		}
		result["ancestor_statuses"] = ancestorStatuses
	}

	return result, nil
}

// DeleteBackendTrafficPolicy deletes a BackendTrafficPolicy.
func (s *Service) DeleteBackendTrafficPolicy(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayPolicyGVR(ctx, "backendtrafficpolicies")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
