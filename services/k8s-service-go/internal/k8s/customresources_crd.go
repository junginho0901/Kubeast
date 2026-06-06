package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetCRDs lists all CustomResourceDefinitions.
func (s *Service) GetCRDs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.dynamicCtx(ctx).Resource(crdGVR).List(ctx, metav1.ListOptions{})
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
	item, err := s.dynamicCtx(ctx).Resource(crdGVR).Get(ctx, name, metav1.GetOptions{})
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
	return s.dynamicCtx(ctx).Resource(crdGVR).Delete(ctx, name, metav1.DeleteOptions{})
}
