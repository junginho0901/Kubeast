package k8s

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// GetAPIResources returns all available API resources in the cluster, cached for 60 seconds.
func (s *Service) GetAPIResources(ctx context.Context) ([]metav1.APIResourceList, error) {
	lists, _, err := s.apiResources(ctx)
	return lists, err
}

// apiResources is GetAPIResources with the time its lists were read from the cluster.
func (s *Service) apiResources(ctx context.Context) ([]metav1.APIResourceList, time.Time, error) {
	cid := ctxClusterID(ctx)
	s.apiResourcesMu.RLock()
	if cached := s.apiResourcesCache[cid]; cached != nil && time.Since(s.apiResourcesAt[cid]) < apiResourcesTTL {
		read := s.apiResourcesRead[cid]
		s.apiResourcesMu.RUnlock()
		return cached, read, nil
	}
	s.apiResourcesMu.RUnlock()

	// One read per cluster at a time, outside the lock: a cluster slow to answer discovery kept every cluster's
	// requests waiting on it (TestOneClustersSlowDiscoveryKeepsNoOtherClusterWaiting).
	v, err, _ := s.apiResourcesSF.Do(string(cid), func() (interface{}, error) {
		s.apiResourcesMu.RLock()
		cached, at, read, gen := s.apiResourcesCache[cid], s.apiResourcesAt[cid], s.apiResourcesRead[cid], s.apiResourcesGen
		s.apiResourcesMu.RUnlock()
		if cached != nil && time.Since(at) < apiResourcesTTL {
			return discovered{cached, read}, nil
		}
		dc := s.discoveryCtx(ctx)
		if dc == nil {
			return nil, errNotLoaded
		}
		groups, lists, err := dc.ServerGroupsAndResources()
		// One aggregated API that does not answer leaves the others known, as kubectl goes on with them. A short cache:
		// the kinds of that API come back when it does.
		partial := discovery.IsGroupDiscoveryFailedError(err)
		if err != nil && !partial {
			return nil, fmt.Errorf("discover API resources: %w", err)
		}
		if partial {
			slog.Warn("some API groups are not answering", "cluster", cid, "err", err)
		}
		result := discovered{preferredFirst(groups, lists), time.Now()}
		s.apiResourcesMu.Lock()
		defer s.apiResourcesMu.Unlock()
		// lists read from a bundle that was replaced meanwhile are not kept
		if gen != s.apiResourcesGen {
			return result, nil
		}
		if s.apiResourcesCache == nil {
			s.apiResourcesCache = map[cluster.ID][]metav1.APIResourceList{}
			s.apiResourcesAt = map[cluster.ID]time.Time{}
			s.apiResourcesRead = map[cluster.ID]time.Time{}
		}
		s.apiResourcesCache[cid] = result.lists
		s.apiResourcesRead[cid] = result.read
		s.apiResourcesAt[cid] = result.read
		if partial {
			s.apiResourcesAt[cid] = result.read.Add(-apiResourcesTTL + apiResourcesPartialTTL)
		}
		return result, nil
	})
	if err != nil {
		return nil, time.Time{}, err
	}
	d := v.(discovered)
	return d.lists, d.read, nil
}

// discovered is one read of a cluster's API resources and when it was read.
type discovered struct {
	lists []metav1.APIResourceList
	read  time.Time
}

const (
	apiResourcesTTL        = 60 * time.Second
	apiResourcesPartialTTL = 10 * time.Second
	// Lists older than this that lack what a request names are read again, as kubectl's discovery mapper reads again on
	// a miss (client-go restmapper DeferredDiscoveryRESTMapper): a CRD created since is found at once, and requests
	// naming a type no API serves read discovery at most once a second per cluster.
	apiResourcesMissTTL = time.Second
)

// newerAPIResources is asked when the lists read at read lack what a request names. It says whether there are newer
// lists to look in: read since by another request, or forgotten here so the next read asks the cluster.
func (s *Service) newerAPIResources(ctx context.Context, read time.Time) bool {
	cid := ctxClusterID(ctx)
	s.apiResourcesMu.Lock()
	defer s.apiResourcesMu.Unlock()
	last := s.apiResourcesRead[cid]
	if last.After(read) {
		return true
	}
	if time.Since(last) < apiResourcesMissTTL || s.discoveryCtx(ctx) == nil {
		return false
	}
	delete(s.apiResourcesCache, cid)
	return true
}

// preferredFirst orders discovery lists so each group's preferred version comes
// before its other versions (then by group/version), since discovery returns
// them in no fixed order and the first match wins in resolveResourceMatch.
func preferredFirst(groups []*metav1.APIGroup, lists []*metav1.APIResourceList) []metav1.APIResourceList {
	preferred := make(map[string]bool, len(groups))
	for _, g := range groups {
		if g != nil {
			preferred[g.PreferredVersion.GroupVersion] = true
		}
	}
	result := make([]metav1.APIResourceList, 0, len(lists))
	for _, list := range lists {
		if list != nil {
			result = append(result, *list)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		pi, pj := preferred[result[i].GroupVersion], preferred[result[j].GroupVersion]
		if pi != pj {
			return pi
		}
		return result[i].GroupVersion < result[j].GroupVersion
	})
	return result
}

// ResourceServed reports whether the request's cluster serves resource in
// group (any version) — false when its CRD is not installed. A discovery
// failure counts as served, so the caller lists as it would without the check.
func (s *Service) ResourceServed(ctx context.Context, group, resource string) bool {
	lists, err := s.GetAPIResources(ctx)
	if err != nil {
		return true
	}
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil || gv.Group != group {
			continue
		}
		for _, r := range l.APIResources {
			if r.Name == resource {
				return true
			}
		}
	}
	return false
}

// ResolveResource resolves a resource type string to a GroupVersionResource.
// It accepts formats like: "pods", "deployments.apps", "gateways.gateway.networking.k8s.io"
func (s *Service) ResolveResource(ctx context.Context, resourceType string) (schema.GroupVersionResource, bool, error) {
	m, err := s.resolveResourceMatch(ctx, resourceType)
	return m.gvr, m.namespaced, err
}

// ResourceScope says whether a resource type is namespaced and whether it is the Namespace kind. A type that does not
// resolve counts as namespaced, the side that has to name a namespace.
func (s *Service) ResourceScope(ctx context.Context, resourceType string) (namespaced, isNamespace bool) {
	m, err := s.resolveResourceMatch(ctx, resourceType)
	if err != nil {
		return true, false
	}
	return m.namespaced, isNamespaceKind(m.gvr)
}

// ResourceKind is the kind of the resource a resource type string resolves to
// ("horizontalpodautoscalers" → "HorizontalPodAutoscaler").
func (s *Service) ResourceKind(ctx context.Context, resourceType string) (string, error) {
	m, err := s.resolveResourceMatch(ctx, resourceType)
	return m.kind, err
}

// ResolveKind resolves an object's apiVersion and kind to the resource that
// serves it in exactly that group and version.
func (s *Service) ResolveKind(ctx context.Context, apiVersion, kind string) (schema.GroupVersionResource, bool, error) {
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return schema.GroupVersionResource{}, false, badInput("%v", err)
	}
	lists, read, err := s.apiResources(ctx)
	if err != nil {
		return schema.GroupVersionResource{}, false, err
	}
	if gvr, namespaced, ok := kindIn(lists, gv, kind); ok {
		return gvr, namespaced, nil
	}
	if s.newerAPIResources(ctx, read) {
		if lists, _, err = s.apiResources(ctx); err != nil {
			return schema.GroupVersionResource{}, false, err
		}
		if gvr, namespaced, ok := kindIn(lists, gv, kind); ok {
			return gvr, namespaced, nil
		}
	}
	// kubectl's words for a kind discovery does not list, then what it suggests
	return schema.GroupVersionResource{}, false, badInput("no matches for kind %q in version %q on this cluster (ensure CRDs are installed first)", kind, apiVersion)
}

func kindIn(lists []metav1.APIResourceList, gv schema.GroupVersion, kind string) (schema.GroupVersionResource, bool, bool) {
	for _, l := range lists {
		if l.GroupVersion != gv.String() {
			continue
		}
		for _, r := range l.APIResources {
			if r.Kind == kind && !strings.Contains(r.Name, "/") {
				return gv.WithResource(r.Name), r.Namespaced, true
			}
		}
	}
	return schema.GroupVersionResource{}, false, false
}

type resourceMatch struct {
	gvr        schema.GroupVersionResource
	namespaced bool
	kind       string
}

// errResourceTypeNotServed: discovery answered and no resource goes by that name.
var errResourceTypeNotServed = errors.New("not found")

func (s *Service) resolveResourceMatch(ctx context.Context, resourceType string) (resourceMatch, error) {
	lists, read, err := s.apiResources(ctx)
	if err != nil {
		return resourceMatch{}, err
	}
	m, err := matchResource(lists, resourceType)
	if errors.Is(err, errResourceTypeNotServed) && s.newerAPIResources(ctx, read) {
		if lists, _, err = s.apiResources(ctx); err != nil {
			return resourceMatch{}, err
		}
		return matchResource(lists, resourceType)
	}
	return m, err
}

func matchResource(lists []metav1.APIResourceList, resourceType string) (resourceMatch, error) {
	// Split into resource name and optional group
	parts := strings.SplitN(resourceType, ".", 2)
	searchName := strings.ToLower(parts[0])
	searchGroup := ""
	if len(parts) > 1 {
		searchGroup = parts[1]
	}

	// Two-pass: prefer core/apps/batch groups first, then fall back to any match
	var coreMatch, anyMatch *resourceMatch

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
				m := &resourceMatch{
					gvr: schema.GroupVersionResource{
						Group:    gv.Group,
						Version:  gv.Version,
						Resource: r.Name,
					},
					namespaced: r.Namespaced,
					kind:       r.Kind,
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
		return *coreMatch, nil
	}
	if anyMatch != nil {
		return *anyMatch, nil
	}

	return resourceMatch{}, fmt.Errorf("resource type %q %w", resourceType, errResourceTypeNotServed)
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
		result["server"] = cluster.WithoutURLUser(rc.Host)
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
