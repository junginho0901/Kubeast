package k8s

import (
	"context"
	"fmt"
	"sort"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// ========== Custom Resource Definitions ==========

var crdGVR = schema.GroupVersionResource{
	Group:    "apiextensions.k8s.io",
	Version:  "v1",
	Resource: "customresourcedefinitions",
}

// GetCRDs lists all CustomResourceDefinitions.
func (s *Service) GetCRDs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Dynamic().Resource(crdGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list crds: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		spec, _ := item.Object["spec"].(map[string]interface{})
		names, _ := spec["names"].(map[string]interface{})
		group, _ := spec["group"].(string)
		scope, _ := spec["scope"].(string)

		kind := ""
		if names != nil {
			kind, _ = names["kind"].(string)
		}

		// Get the storage version
		version := ""
		if versions, ok := spec["versions"].([]interface{}); ok {
			for _, v := range versions {
				vm, _ := v.(map[string]interface{})
				if storage, _ := vm["storage"].(bool); storage {
					version, _ = vm["name"].(string)
					break
				}
			}
			if version == "" && len(versions) > 0 {
				vm, _ := versions[0].(map[string]interface{})
				version, _ = vm["name"].(string)
			}
		}

		createdAt := ""
		if ts := item.GetCreationTimestamp(); !ts.IsZero() {
			createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
		}

		result = append(result, map[string]interface{}{
			"name":       item.GetName(),
			"group":      group,
			"version":    version,
			"scope":      scope,
			"kind":       kind,
			"created_at": createdAt,
			"labels":     item.GetLabels(),
			"annotations": item.GetAnnotations(),
		})
	}
	return result, nil
}

// DescribeCRD returns detailed info about a CRD.
func (s *Service) DescribeCRD(ctx context.Context, name string) (map[string]interface{}, error) {
	item, err := s.Dynamic().Resource(crdGVR).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get crd %s: %w", name, err)
	}

	spec, _ := item.Object["spec"].(map[string]interface{})
	status, _ := item.Object["status"].(map[string]interface{})
	names, _ := spec["names"].(map[string]interface{})
	group, _ := spec["group"].(string)
	scope, _ := spec["scope"].(string)

	kind := ""
	plural := ""
	singular := ""
	listKind := ""
	var shortNames []interface{}
	var categories []interface{}
	if names != nil {
		kind, _ = names["kind"].(string)
		plural, _ = names["plural"].(string)
		singular, _ = names["singular"].(string)
		listKind, _ = names["listKind"].(string)
		shortNames, _ = names["shortNames"].([]interface{})
		categories, _ = names["categories"].([]interface{})
	}

	// Versions
	versions := make([]map[string]interface{}, 0)
	if rawVersions, ok := spec["versions"].([]interface{}); ok {
		for _, v := range rawVersions {
			vm, _ := v.(map[string]interface{})
			served, _ := vm["served"].(bool)
			storage, _ := vm["storage"].(bool)
			vName, _ := vm["name"].(string)

			vEntry := map[string]interface{}{
				"name":    vName,
				"served":  served,
				"storage": storage,
			}

			// Additional printer columns
			if cols, ok := vm["additionalPrinterColumns"].([]interface{}); ok {
				vEntry["additionalPrinterColumns"] = cols
			}

			versions = append(versions, vEntry)
		}
	}

	// Conditions from status
	var conditions []interface{}
	if status != nil {
		conditions, _ = status["conditions"].([]interface{})
	}

	// Accepted names from status
	var acceptedNames map[string]interface{}
	if status != nil {
		acceptedNames, _ = status["acceptedNames"].(map[string]interface{})
	}

	// Stored versions
	var storedVersions []interface{}
	if status != nil {
		storedVersions, _ = status["storedVersions"].([]interface{})
	}

	// Subresources (from versions)
	subresources := make(map[string]bool)
	if rawVersions, ok := spec["versions"].([]interface{}); ok {
		for _, v := range rawVersions {
			vm, _ := v.(map[string]interface{})
			if subs, ok := vm["subresources"].(map[string]interface{}); ok {
				for k := range subs {
					subresources[k] = true
				}
			}
		}
	}

	createdAt := ""
	if ts := item.GetCreationTimestamp(); !ts.IsZero() {
		createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
	}

	result := map[string]interface{}{
		"name":             item.GetName(),
		"uid":              string(item.GetUID()),
		"resource_version": item.GetResourceVersion(),
		"created_at":       createdAt,
		"labels":           item.GetLabels(),
		"annotations":      item.GetAnnotations(),
		"group":            group,
		"scope":            scope,
		"kind":             kind,
		"plural":           plural,
		"singular":         singular,
		"list_kind":        listKind,
		"short_names":      shortNames,
		"categories":       categories,
		"versions":         versions,
		"conditions":       conditions,
		"accepted_names":   acceptedNames,
		"stored_versions":  storedVersions,
		"subresources":     subresourcesToList(subresources),
	}

	return result, nil
}

// DeleteCRD deletes a CustomResourceDefinition.
func (s *Service) DeleteCRD(ctx context.Context, name string) error {
	return s.Dynamic().Resource(crdGVR).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Custom Resource Instances ==========

// GetAllCustomResourceInstances lists all custom resource instances across all CRDs.
func (s *Service) GetAllCustomResourceInstances(ctx context.Context) ([]map[string]interface{}, error) {
	// First get all CRDs
	crdList, err := s.Dynamic().Resource(crdGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list crds for instances: %w", err)
	}

	type crResult struct {
		items []map[string]interface{}
		err   error
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	allItems := make([]map[string]interface{}, 0)

	// Limit concurrency
	sem := make(chan struct{}, 10)

	for _, crdItem := range crdList.Items {
		spec, _ := crdItem.Object["spec"].(map[string]interface{})
		if spec == nil {
			continue
		}
		names, _ := spec["names"].(map[string]interface{})
		if names == nil {
			continue
		}

		group, _ := spec["group"].(string)
		scope, _ := spec["scope"].(string)
		crKind, _ := names["kind"].(string)
		crPlural, _ := names["plural"].(string)

		// Find storage version
		version := ""
		if rawVersions, ok := spec["versions"].([]interface{}); ok {
			for _, v := range rawVersions {
				vm, _ := v.(map[string]interface{})
				if storage, _ := vm["storage"].(bool); storage {
					version, _ = vm["name"].(string)
					break
				}
			}
			if version == "" && len(rawVersions) > 0 {
				vm, _ := rawVersions[0].(map[string]interface{})
				version, _ = vm["name"].(string)
			}
		}

		if crPlural == "" || version == "" {
			continue
		}

		gvr := schema.GroupVersionResource{
			Group:    group,
			Version:  version,
			Resource: crPlural,
		}

		wg.Add(1)
		go func(gvr schema.GroupVersionResource, crKind, group, version, scope string, crdName string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			crList, err := s.Dynamic().Resource(gvr).List(ctx, metav1.ListOptions{})
			if err != nil {
				// Skip CRDs that fail (e.g., permission issues)
				return
			}

			items := make([]map[string]interface{}, 0, len(crList.Items))
			for _, cr := range crList.Items {
				createdAt := ""
				if ts := cr.GetCreationTimestamp(); !ts.IsZero() {
					createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
				}

				items = append(items, map[string]interface{}{
					"name":       cr.GetName(),
					"namespace":  cr.GetNamespace(),
					"kind":       crKind,
					"group":      group,
					"version":    version,
					"scope":      scope,
					"crd_name":   crdName,
					"created_at": createdAt,
					"labels":     cr.GetLabels(),
				})
			}

			mu.Lock()
			allItems = append(allItems, items...)
			mu.Unlock()
		}(gvr, crKind, group, version, scope, crdItem.GetName())
	}

	wg.Wait()

	// Sort by creation time descending
	sort.Slice(allItems, func(i, j int) bool {
		ti, _ := allItems[i]["created_at"].(string)
		tj, _ := allItems[j]["created_at"].(string)
		return ti > tj
	})

	return allItems, nil
}

// GetCustomResourceInstances lists instances of a specific CR type.
func (s *Service) GetCustomResourceInstances(ctx context.Context, group, version, plural string) ([]map[string]interface{}, error) {
	gvr := schema.GroupVersionResource{
		Group:    group,
		Version:  version,
		Resource: plural,
	}

	list, err := s.Dynamic().Resource(gvr).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list custom resources %s/%s/%s: %w", group, version, plural, err)
	}

	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		createdAt := ""
		if ts := item.GetCreationTimestamp(); !ts.IsZero() {
			createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
		}

		entry := map[string]interface{}{
			"name":        item.GetName(),
			"namespace":   item.GetNamespace(),
			"kind":        item.GetKind(),
			"group":       group,
			"version":     version,
			"created_at":  createdAt,
			"labels":      item.GetLabels(),
			"annotations": item.GetAnnotations(),
		}

		// Include spec and status for JSONPath evaluation
		if spec, ok := item.Object["spec"]; ok {
			entry["spec"] = spec
		}
		if status, ok := item.Object["status"]; ok {
			entry["status"] = status
		}

		result = append(result, entry)
	}
	return result, nil
}

// DescribeCustomResourceInstance returns detailed info about a custom resource instance.
func (s *Service) DescribeCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) (map[string]interface{}, error) {
	gvr := schema.GroupVersionResource{
		Group:    group,
		Version:  version,
		Resource: plural,
	}

	var item *unstructured.Unstructured
	var itemErr error
	var events *corev1.EventList
	var eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		if namespace != "" && namespace != "-" {
			item, itemErr = s.Dynamic().Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
		} else {
			item, itemErr = s.Dynamic().Resource(gvr).Get(ctx, name, metav1.GetOptions{})
		}
	}()

	go func() {
		defer wg.Done()
		evtNs := namespace
		if evtNs == "" || evtNs == "-" {
			evtNs = ""
		}
		events, eventsErr = s.Clientset().CoreV1().Events(evtNs).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s", name),
		})
	}()

	wg.Wait()

	if itemErr != nil {
		return nil, fmt.Errorf("get custom resource %s/%s: %w", namespace, name, itemErr)
	}

	createdAt := ""
	if ts := item.GetCreationTimestamp(); !ts.IsZero() {
		createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
	}

	result := map[string]interface{}{
		"name":             item.GetName(),
		"namespace":        item.GetNamespace(),
		"uid":              string(item.GetUID()),
		"resource_version": item.GetResourceVersion(),
		"created_at":       createdAt,
		"labels":           item.GetLabels(),
		"annotations":      item.GetAnnotations(),
		"kind":             item.GetKind(),
		"api_version":      item.GetAPIVersion(),
	}

	// Include spec and status if present
	if spec, ok := item.Object["spec"]; ok {
		result["spec"] = spec
	}
	if status, ok := item.Object["status"]; ok {
		result["status"] = status
	}

	// Owner references
	if ownerRefs := item.GetOwnerReferences(); len(ownerRefs) > 0 {
		refs := make([]map[string]interface{}, 0, len(ownerRefs))
		for _, ref := range ownerRefs {
			refs = append(refs, map[string]interface{}{
				"kind": ref.Kind,
				"name": ref.Name,
				"uid":  string(ref.UID),
			})
		}
		result["owner_references"] = refs
	}

	// Finalizers
	if finalizers := item.GetFinalizers(); len(finalizers) > 0 {
		result["finalizers"] = finalizers
	}

	// Events
	if eventsErr == nil && events != nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

func subresourcesToList(m map[string]bool) []string {
	result := make([]string, 0, len(m))
	for k := range m {
		result = append(result, k)
	}
	return result
}

// DeleteCustomResourceInstance deletes a custom resource instance.
func (s *Service) DeleteCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) error {
	gvr := schema.GroupVersionResource{
		Group:    group,
		Version:  version,
		Resource: plural,
	}

	if namespace != "" && namespace != "-" {
		return s.Dynamic().Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}
	return s.Dynamic().Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
}
