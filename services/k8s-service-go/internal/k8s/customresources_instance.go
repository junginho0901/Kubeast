package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GetAllCustomResourceInstances lists all custom resource instances across all CRDs.
func (s *Service) GetAllCustomResourceInstances(ctx context.Context) ([]map[string]interface{}, error) {
	// First get all CRDs
	crdList, err := s.dynamicCtx(ctx).Resource(crdGVR).List(ctx, metav1.ListOptions{})
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
	nsScope := scopeFromCtx(ctx) // a namespace-scoped grant: namespaced CRDs are listed per granted namespace

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

			var crItems []unstructured.Unstructured
			if len(nsScope) > 0 && scope == "Namespaced" {
				for _, ns := range nsScope {
					if l, err := s.dynamicCtx(ctx).Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{}); err == nil {
						crItems = append(crItems, l.Items...)
					}
				}
			} else {
				crList, err := s.dynamicCtx(ctx).Resource(gvr).List(ctx, metav1.ListOptions{})
				if err != nil {
					// Skip CRDs that fail (e.g., permission issues)
					return
				}
				crItems = crList.Items
			}

			items := make([]map[string]interface{}, 0, len(crItems))
			for _, cr := range crItems {
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
	t, err := s.customResourceTable(ctx, group, version, plural)
	if err != nil {
		return nil, fmt.Errorf("list custom resources %s/%s/%s: %w", group, version, plural, err)
	}
	return customResourceRows(t, group, version), nil
}

// DescribeCustomResourceInstance is a custom resource as its drawer shows it: the row the instances list shows (the
// API server's Table of the CRD's columns at this version, for this one object — customResourceRows), the object's
// metadata and the events about it, found as kubectl describe finds them (involvedObject name and kind, in every
// namespace for a cluster-scoped kind).
func (s *Service) DescribeCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) (map[string]interface{}, error) {
	t, err := s.customResourceObjectTable(ctx, group, version, plural, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get custom resource %s/%s: %w", namespace, name, err)
	}
	rows := customResourceRows(t, group, version)
	if len(t.Rows) != 1 || len(rows) != 1 {
		return nil, fmt.Errorf("get custom resource %s/%s: the API server answered %d rows", namespace, name, len(t.Rows))
	}
	item := &unstructured.Unstructured{}
	if err := json.Unmarshal(t.Rows[0].Object.Raw, &item.Object); err != nil {
		return nil, fmt.Errorf("get custom resource %s/%s: %w", namespace, name, err)
	}

	evtNs := namespace
	if evtNs == "-" {
		evtNs = ""
	}
	events, eventsErr := s.clientsetCtx(ctx).CoreV1().Events(evtNs).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=%s", name, item.GetKind()),
	})
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := rows[0]
	result["uid"] = string(item.GetUID())
	result["resource_version"] = item.GetResourceVersion()
	result["api_version"] = item.GetAPIVersion()
	result["events"] = formatEventList(events.Items)

	if fields := topLevelFields(item.Object); len(fields) > 0 {
		result["fields"] = fields
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

	// Managed fields summary (server-side apply tracking)
	if managed := item.GetManagedFields(); len(managed) > 0 {
		mfs := make([]map[string]interface{}, 0, len(managed))
		for _, mf := range managed {
			entry := map[string]interface{}{
				"manager":     mf.Manager,
				"operation":   string(mf.Operation),
				"api_version": mf.APIVersion,
				"subresource": mf.Subresource,
			}
			if mf.Time != nil {
				entry["time"] = mf.Time.UTC().Format("2006-01-02T15:04:05Z")
			}
			mfs = append(mfs, entry)
		}
		result["managed_fields"] = mfs
	}

	return result, nil
}

// DeleteCustomResourceInstance deletes a custom resource instance.
func (s *Service) DeleteCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) error {
	gvr := schema.GroupVersionResource{
		Group:    group,
		Version:  version,
		Resource: plural,
	}

	if namespace != "" && namespace != "-" {
		return s.dynamicCtx(ctx).Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}
	return s.dynamicCtx(ctx).Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
}

// topLevelFields returns what an object keeps beside apiVersion, kind, metadata, spec and status — a
// PolicyReport's scope, summary and results — for the drawer, whose CRD printer columns may point there.
func topLevelFields(obj map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range obj {
		switch k {
		case "apiVersion", "kind", "metadata", "spec", "status":
		default:
			out[k] = v
		}
	}
	return out
}
