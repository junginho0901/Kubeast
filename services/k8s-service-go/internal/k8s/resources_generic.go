package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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

// Advanced Search lists in pages, as kubectl does (--chunk-size 500), so one list of a large cluster no longer
// holds every object in k8s-service's memory (10 000 pods took it past its 512Mi limit, 10-29), and stops after
// the page's own limit of objects of a type — at most SearchMaxItems, the most the page lets a person ask for.
const (
	SearchPageSize = 500
	SearchMaxItems = 10000
)

// StreamGenericResourcesRaw lists resources page by page as full unstructured objects without managedFields:
// head once with the list's kind and apiVersion after the first page and before any item, then item for each
// object, up to max of them. truncated says more were there; remaining counts them when the API server tells.
func (s *Service) StreamGenericResourcesRaw(ctx context.Context, resourceType, namespace, labelSelector string, max int,
	head func(kind, apiVersion string) error, item func(map[string]interface{}) error) (truncated bool, remaining int64, err error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return false, 0, err
	}
	if !namespaced {
		namespace = ""
	}
	list := func(opts metav1.ListOptions) (*unstructured.UnstructuredList, error) {
		l, err := s.ListResources(ctx, gvr, namespace, opts)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", resourceType, err)
		}
		return l, nil
	}
	return streamPages(list, metav1.ListOptions{LabelSelector: labelSelector}, SearchPageSize, max, head, item)
}

// streamPages runs a list in pages of size (limit and continue) and hands its objects on, up to max.
func streamPages(list func(metav1.ListOptions) (*unstructured.UnstructuredList, error), opts metav1.ListOptions, size, max int,
	head func(kind, apiVersion string) error, item func(map[string]interface{}) error) (bool, int64, error) {
	opts.Limit = int64(size)
	sent := 0
	for first := true; ; first = false {
		page, err := list(opts)
		if err != nil {
			return false, 0, err
		}
		if first {
			if err := head(page.GetKind(), page.GetAPIVersion()); err != nil {
				return false, 0, err
			}
		}
		for i := range page.Items {
			if sent == max {
				remaining := int64(len(page.Items) - i)
				if rc := page.GetRemainingItemCount(); rc != nil {
					remaining += *rc
				} else if page.GetContinue() != "" {
					remaining = 0 // more pages, count unknown
				}
				return true, remaining, nil
			}
			page.Items[i].SetManagedFields(nil)
			if err := item(page.Items[i].Object); err != nil {
				return false, 0, err
			}
			sent++
		}
		if page.GetContinue() == "" {
			return false, 0, nil
		}
		if sent == max { // a full page ended at max: the API server's count of the rest, if it gave one
			var remaining int64
			if rc := page.GetRemainingItemCount(); rc != nil {
				remaining = *rc
			}
			return true, remaining, nil
		}
		opts.Continue = page.GetContinue()
	}
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
