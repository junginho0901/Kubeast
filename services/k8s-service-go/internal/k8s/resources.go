package k8s

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"gopkg.in/yaml.v3"
)

// GetAPIResources returns all available API resources in the cluster, cached for 60 seconds.
func (s *Service) GetAPIResources(ctx context.Context) ([]metav1.APIResourceList, error) {
	s.apiResourcesMu.RLock()
	if s.apiResourcesCache != nil && time.Since(s.apiResourcesAt) < 60*time.Second {
		cached := s.apiResourcesCache
		s.apiResourcesMu.RUnlock()
		return cached, nil
	}
	s.apiResourcesMu.RUnlock()

	s.apiResourcesMu.Lock()
	defer s.apiResourcesMu.Unlock()

	// Double-check after acquiring write lock
	if s.apiResourcesCache != nil && time.Since(s.apiResourcesAt) < 60*time.Second {
		return s.apiResourcesCache, nil
	}

	_, lists, err := s.Discovery().ServerGroupsAndResources()
	if err != nil {
		return nil, fmt.Errorf("discover API resources: %w", err)
	}

	result := make([]metav1.APIResourceList, 0, len(lists))
	for _, list := range lists {
		if list != nil {
			result = append(result, *list)
		}
	}

	s.apiResourcesCache = result
	s.apiResourcesAt = time.Now()
	return result, nil
}

// ResolveResource resolves a resource type string to a GroupVersionResource.
// It accepts formats like: "pods", "deployments.apps", "gateways.gateway.networking.k8s.io"
func (s *Service) ResolveResource(ctx context.Context, resourceType string) (schema.GroupVersionResource, bool, error) {
	lists, err := s.GetAPIResources(ctx)
	if err != nil {
		return schema.GroupVersionResource{}, false, err
	}

	// Split into resource name and optional group
	parts := strings.SplitN(resourceType, ".", 2)
	searchName := strings.ToLower(parts[0])
	searchGroup := ""
	if len(parts) > 1 {
		searchGroup = parts[1]
	}

	// Two-pass: prefer core/apps/batch groups first, then fall back to any match
	type match struct {
		gvr        schema.GroupVersionResource
		namespaced bool
	}
	var coreMatch, anyMatch *match

	for _, list := range lists {
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}

		// If group was specified, must match
		if searchGroup != "" && gv.Group != searchGroup {
			continue
		}

		for _, r := range list.APIResources {
			nameLower := strings.ToLower(r.Name)
			kindLower := strings.ToLower(r.Kind)

			matched := nameLower == searchName || kindLower == searchName ||
				strings.ToLower(r.SingularName) == searchName

			// Check short names
			if !matched {
				for _, sn := range r.ShortNames {
					if strings.ToLower(sn) == searchName {
						matched = true
						break
					}
				}
			}

			if matched {
				m := &match{
					gvr: schema.GroupVersionResource{
						Group:    gv.Group,
						Version:  gv.Version,
						Resource: r.Name,
					},
					namespaced: r.Namespaced,
				}
				// Prefer core API groups (empty, apps, batch, networking.k8s.io, etc.)
				if gv.Group == "" || gv.Group == "apps" || gv.Group == "batch" ||
					gv.Group == "networking.k8s.io" || gv.Group == "rbac.authorization.k8s.io" ||
					gv.Group == "storage.k8s.io" || gv.Group == "policy" {
					if coreMatch == nil {
						coreMatch = m
					}
				} else if anyMatch == nil {
					anyMatch = m
				}
			}
		}
	}

	if coreMatch != nil {
		return coreMatch.gvr, coreMatch.namespaced, nil
	}
	if anyMatch != nil {
		return anyMatch.gvr, anyMatch.namespaced, nil
	}

	return schema.GroupVersionResource{}, false, fmt.Errorf("resource type %q not found", resourceType)
}

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
			"name":       item.GetName(),
			"namespace":  item.GetNamespace(),
			"kind":       item.GetKind(),
			"api_version": item.GetAPIVersion(),
			"labels":     item.GetLabels(),
			"created_at": toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
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

	cacheKey := fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name)
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

// GetAPIResourcesFlat returns all API resources as a flat list of maps.
func (s *Service) GetAPIResourcesFlat(ctx context.Context) ([]map[string]interface{}, error) {
	lists, err := s.GetAPIResources(ctx)
	if err != nil {
		return nil, err
	}

	var result []map[string]interface{}
	for _, list := range lists {
		gv, parseErr := schema.ParseGroupVersion(list.GroupVersion)
		if parseErr != nil {
			continue
		}
		for _, r := range list.APIResources {
			verbs := make([]string, 0, len(r.Verbs))
			for _, v := range r.Verbs {
				verbs = append(verbs, string(v))
			}
			result = append(result, map[string]interface{}{
				"group":       gv.Group,
				"version":     gv.Version,
				"resource":    r.Name,
				"kind":        r.Kind,
				"namespaced":  r.Namespaced,
				"verbs":       verbs,
				"short_names": r.ShortNames,
			})
		}
	}
	return result, nil
}

// ApplyResourceYAML applies a strategic merge patch to a resource from YAML.
func (s *Service) ApplyResourceYAML(ctx context.Context, resourceType, namespace, name, yamlStr string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	// Parse YAML to JSON for the patch
	var parsed interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &parsed); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}

	patchData, err := json.Marshal(parsed)
	if err != nil {
		return nil, fmt.Errorf("marshal patch: %w", err)
	}

	var patched *unstructured.Unstructured
	if ns != "" {
		patched, err = s.Dynamic().Resource(gvr).Namespace(ns).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	} else {
		patched, err = s.Dynamic().Resource(gvr).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	if err != nil {
		return nil, fmt.Errorf("patch %s %s: %w", resourceType, name, err)
	}

	// Invalidate cache
	cacheKey := fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name)
	s.cache.Delete(ctx, cacheKey)

	return map[string]interface{}{
		"name":        patched.GetName(),
		"namespace":   patched.GetNamespace(),
		"kind":        patched.GetKind(),
		"api_version": patched.GetAPIVersion(),
		"message":     fmt.Sprintf("%s %s updated", resourceType, name),
	}, nil
}

// CreateResourcesFromYAML creates resources from a YAML string, supporting multi-document YAML.
func (s *Service) CreateResourcesFromYAML(ctx context.Context, yamlStr string) ([]map[string]interface{}, error) {
	var results []map[string]interface{}

	reader := bufio.NewReader(bytes.NewBufferString(yamlStr))
	decoder := yaml.NewDecoder(reader)

	for {
		var rawObj map[string]interface{}
		err := decoder.Decode(&rawObj)
		if err == io.EOF {
			break
		}
		if err != nil {
			return results, fmt.Errorf("decode YAML document: %w", err)
		}
		if rawObj == nil {
			continue
		}

		// Convert to JSON for the unstructured object
		jsonData, err := json.Marshal(rawObj)
		if err != nil {
			return results, fmt.Errorf("marshal to JSON: %w", err)
		}

		obj := &unstructured.Unstructured{}
		if err := json.Unmarshal(jsonData, &obj.Object); err != nil {
			return results, fmt.Errorf("unmarshal to unstructured: %w", err)
		}

		// Resolve the GVR from the object's apiVersion and kind
		apiVersion := obj.GetAPIVersion()
		kind := obj.GetKind()
		if apiVersion == "" || kind == "" {
			return results, fmt.Errorf("YAML document missing apiVersion or kind")
		}

		gvr, namespaced, err := s.ResolveResource(ctx, strings.ToLower(kind))
		if err != nil {
			// Try with plural forms or group
			gv, _ := schema.ParseGroupVersion(apiVersion)
			gvr, namespaced, err = s.ResolveResource(ctx, strings.ToLower(kind)+"."+gv.Group)
			if err != nil {
				return results, fmt.Errorf("resolve resource for %s/%s: %w", apiVersion, kind, err)
			}
		}

		namespace := obj.GetNamespace()
		if !namespaced {
			namespace = ""
		}

		created, err := s.CreateResource(ctx, gvr, namespace, obj)
		if err != nil {
			return results, fmt.Errorf("create %s %s: %w", kind, obj.GetName(), err)
		}

		results = append(results, map[string]interface{}{
			"name":        created.GetName(),
			"namespace":   created.GetNamespace(),
			"kind":        created.GetKind(),
			"api_version": created.GetAPIVersion(),
			"message":     fmt.Sprintf("%s %s created", kind, created.GetName()),
		})
	}

	return results, nil
}

// GetClusterConfig returns sanitized cluster configuration (no credentials).
func (s *Service) GetClusterConfig(ctx context.Context) (map[string]interface{}, error) {
	result := map[string]interface{}{}

	// Server URL
	if s.RestConfig() != nil {
		result["server"] = s.RestConfig().Host
	}

	// Cluster version
	sv, err := s.Clientset().Discovery().ServerVersion()
	if err == nil {
		result["version"] = map[string]interface{}{
			"major":        sv.Major,
			"minor":        sv.Minor,
			"git_version":  sv.GitVersion,
			"git_commit":   sv.GitCommit,
			"build_date":   sv.BuildDate,
			"go_version":   sv.GoVersion,
			"compiler":     sv.Compiler,
			"platform":     sv.Platform,
		}
	}

	// API groups
	groups, err := s.Discovery().ServerGroups()
	if err == nil {
		groupNames := make([]string, 0, len(groups.Groups))
		for _, g := range groups.Groups {
			if g.Name == "" {
				groupNames = append(groupNames, "core")
			} else {
				groupNames = append(groupNames, g.Name)
			}
		}
		result["api_groups"] = groupNames
	}

	return result, nil
}
