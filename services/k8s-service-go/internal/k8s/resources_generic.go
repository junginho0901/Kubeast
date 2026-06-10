package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetGenericResources lists any resource type by name.
func (s *Service) GetGenericResources(ctx context.Context, resourceType, namespace, labelSelector string) ([]map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	list, err := s.ListResources(ctx, gvr, ns, opts)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", resourceType, err)
	}

	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":        item.GetName(),
			"namespace":   item.GetNamespace(),
			"kind":        item.GetKind(),
			"api_version": item.GetAPIVersion(),
			"labels":      item.GetLabels(),
			"created_at":  toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		// Extract common status fields if present
		if status := mapMap(item.Object, "status"); status != nil {
			if phase := mapStr(status, "phase"); phase != "" {
				entry["phase"] = phase
			}
			if conditions := mapSlice(status, "conditions"); len(conditions) > 0 {
				entry["condition_count"] = len(conditions)
			}
		}

		result = append(result, entry)
	}
	return result, nil
}

// GetGenericResourcesRaw lists resources returning full unstructured K8s objects.
func (s *Service) GetGenericResourcesRaw(ctx context.Context, resourceType, namespace, labelSelector string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	list, err := s.ListResources(ctx, gvr, ns, opts)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", resourceType, err)
	}

	// Return full objects, strip managedFields to reduce size
	items := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		item.SetManagedFields(nil)
		items = append(items, item.Object)
	}

	return map[string]interface{}{
		"kind":       list.GetKind(),
		"apiVersion": list.GetAPIVersion(),
		"items":      items,
	}, nil
}

// GetGenericResourceRaw fetches a single resource returning the full unstructured K8s object.
func (s *Service) GetGenericResourceRaw(ctx context.Context, resourceType, namespace, name string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return nil, fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)
	return obj.Object, nil
}

// DescribeGenericResource returns details for any resource type.
func (s *Service) DescribeGenericResource(ctx context.Context, resourceType, namespace, name string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return nil, fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"kind":        obj.GetKind(),
		"api_version": obj.GetAPIVersion(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	if ownerRefs := obj.GetOwnerReferences(); len(ownerRefs) > 0 {
		owners := make([]map[string]interface{}, 0, len(ownerRefs))
		for _, or := range ownerRefs {
			owners = append(owners, map[string]interface{}{
				"kind": or.Kind,
				"name": or.Name,
				"uid":  string(or.UID),
			})
		}
		result["owner_references"] = owners
	}

	if spec := mapMap(obj.Object, "spec"); spec != nil {
		result["spec"] = spec
	}

	if status := mapMap(obj.Object, "status"); status != nil {
		result["status"] = status
	}

	return result, nil
}

// GetGenericResourceYAML returns any resource as YAML.
func (s *Service) GetGenericResourceYAML(ctx context.Context, resourceType, namespace, name string, forceRefresh bool) (string, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return "", err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	cacheKey := s.clusterCacheKey(ctx, fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name))
	if !forceRefresh {
		var cached string
		if s.cache.Get(ctx, cacheKey, &cached) {
			return cached, nil
		}
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return "", fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)

	data, err := json.Marshal(obj.Object)
	if err != nil {
		return "", fmt.Errorf("marshal %s: %w", resourceType, err)
	}

	yamlStr := jsonToYAML(data)
	s.cache.Set(ctx, cacheKey, yamlStr, 10*time.Second)
	return yamlStr, nil
}
