package k8s

import (
	"context"
	"fmt"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// GetAPIResources returns all available API resources in the cluster, cached for 60 seconds.
func (s *Service) GetAPIResources(ctx context.Context) ([]metav1.APIResourceList, error) {
	cid := ctxClusterID(ctx)
	s.apiResourcesMu.RLock()
	if cached := s.apiResourcesCache[cid]; cached != nil && time.Since(s.apiResourcesAt[cid]) < 60*time.Second {
		s.apiResourcesMu.RUnlock()
		return cached, nil
	}
	s.apiResourcesMu.RUnlock()

	s.apiResourcesMu.Lock()
	defer s.apiResourcesMu.Unlock()
	if s.apiResourcesCache == nil {
		s.apiResourcesCache = map[cluster.ID][]metav1.APIResourceList{}
		s.apiResourcesAt = map[cluster.ID]time.Time{}
	}

	// Double-check after acquiring write lock
	if cached := s.apiResourcesCache[cid]; cached != nil && time.Since(s.apiResourcesAt[cid]) < 60*time.Second {
		return cached, nil
	}

	_, lists, err := s.discoveryCtx(ctx).ServerGroupsAndResources()
	if err != nil {
		return nil, fmt.Errorf("discover API resources: %w", err)
	}

	result := make([]metav1.APIResourceList, 0, len(lists))
	for _, list := range lists {
		if list != nil {
			result = append(result, *list)
		}
	}

	s.apiResourcesCache[cid] = result
	s.apiResourcesAt[cid] = time.Now()
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

// GetClusterConfig returns sanitized cluster configuration (no credentials).
func (s *Service) GetClusterConfig(ctx context.Context) (map[string]interface{}, error) {
	result := map[string]interface{}{}

	// Server URL
	if rc := s.restConfigCtx(ctx); rc != nil {
		result["server"] = rc.Host
	}

	// Cluster version
	sv, err := s.clientsetCtx(ctx).Discovery().ServerVersion()
	if err == nil {
		result["version"] = map[string]interface{}{
			"major":       sv.Major,
			"minor":       sv.Minor,
			"git_version": sv.GitVersion,
			"git_commit":  sv.GitCommit,
			"build_date":  sv.BuildDate,
			"go_version":  sv.GoVersion,
			"compiler":    sv.Compiler,
			"platform":    sv.Platform,
		}
	}

	// API groups
	groups, err := s.discoveryCtx(ctx).ServerGroups()
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
