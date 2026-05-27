package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetReferenceGrants lists reference grants in a namespace.
func (s *Service) GetReferenceGrants(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	list, err := s.ListResources(ctx, gvr, namespace, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list referencegrants: %w", err)
	}
	return formatReferenceGrantList(list), nil
}

// GetAllReferenceGrants lists reference grants across all namespaces.
func (s *Service) GetAllReferenceGrants(ctx context.Context) ([]map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	list, err := s.ListResources(ctx, gvr, "", metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all referencegrants: %w", err)
	}
	return formatReferenceGrantList(list), nil
}

// DescribeReferenceGrant returns detailed info about a reference grant.
func (s *Service) DescribeReferenceGrant(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get referencegrant %s/%s: %w", namespace, name, err)
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
		result["from"] = fromList

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
		result["to"] = toList
	}

	return result, nil
}

// DeleteReferenceGrant deletes a reference grant.
func (s *Service) DeleteReferenceGrant(ctx context.Context, namespace, name string) error {
	gvr := s.gatewayGVR(ctx, "referencegrants")
	return s.DeleteResource(ctx, gvr, namespace, name)
}
