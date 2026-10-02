package k8s

import (
	"context"
	"log/slog"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

// resolvedResource is what API discovery says about one resource of a group:
// the version it is served under, its kind and whether it is namespaced.
type resolvedResource struct {
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
}

type resolvedEntry struct {
	res resolvedResource
	ok  bool
	at  time.Time
}

// negativeResolveTTL bounds how long "this cluster does not serve the resource"
// is remembered, so a CRD installed later shows up without a restart.
const negativeResolveTTL = 60 * time.Second

// resolveResource finds the version under which the cluster serves
// group/resource, through API discovery: the group's versions are tried in the
// server's preferred order and the first one listing the resource wins. The
// same group can serve different kinds under different versions (Gateway API:
// gateways v1, referencegrants v1beta1; resource.k8s.io: v1 since 1.34), which
// is why the lookup is per resource rather than per group. Positive answers
// are cached per cluster until the kubeconfig is reloaded; negative ones for
// negativeResolveTTL.
func (s *Service) resolveResource(ctx context.Context, group, resource string) (resolvedResource, bool) {
	key := string(ctxClusterID(ctx)) + "|" + group + "/" + resource
	s.resolveMu.RLock()
	e, hit := s.resolveCache[key]
	s.resolveMu.RUnlock()
	if hit && (e.ok || time.Since(e.at) < negativeResolveTTL) {
		return e.res, e.ok
	}

	res, ok := s.discoverResource(ctx, group, resource)

	s.resolveMu.Lock()
	if s.resolveCache == nil {
		s.resolveCache = map[string]resolvedEntry{}
	}
	s.resolveCache[key] = resolvedEntry{res: res, ok: ok, at: time.Now()}
	s.resolveMu.Unlock()
	if ok {
		slog.Info("api version resolved", "cluster", ctxClusterID(ctx), "group", group, "resource", resource, "version", res.GVR.Version)
	} else {
		// every built-in / configured policy kind is probed on a cluster that lacks it: keep that quiet
		slog.Debug("api resource not served", "cluster", ctxClusterID(ctx), "group", group, "resource", resource)
	}
	return res, ok
}

func (s *Service) discoverResource(ctx context.Context, group, resource string) (resolvedResource, bool) {
	disc := s.discoveryCtx(ctx)
	if disc == nil {
		return resolvedResource{}, false
	}
	groups, err := disc.ServerGroups()
	if err != nil || groups == nil {
		return resolvedResource{}, false
	}
	for _, g := range groups.Groups {
		if g.Name != group {
			continue
		}
		versions := make([]string, 0, len(g.Versions)+1)
		if g.PreferredVersion.Version != "" {
			versions = append(versions, g.PreferredVersion.Version)
		}
		for _, v := range g.Versions {
			if v.Version != g.PreferredVersion.Version {
				versions = append(versions, v.Version)
			}
		}
		for _, v := range versions {
			list, err := disc.ServerResourcesForGroupVersion(schema.GroupVersion{Group: group, Version: v}.String())
			if err != nil || list == nil {
				continue
			}
			for _, r := range list.APIResources {
				if r.Name == resource {
					return resolvedResource{
						GVR:        schema.GroupVersionResource{Group: group, Version: v, Resource: resource},
						Kind:       r.Kind,
						Namespaced: r.Namespaced,
					}, true
				}
			}
		}
		return resolvedResource{}, false
	}
	return resolvedResource{}, false
}

// resolveGVR is resolveResource for callers that only need the GVR.
func (s *Service) resolveGVR(ctx context.Context, group, resource string) (schema.GroupVersionResource, bool) {
	res, ok := s.resolveResource(ctx, group, resource)
	return res.GVR, ok
}

// invalidateResolveCache forgets every discovery answer (kubeconfig reload).
func (s *Service) invalidateResolveCache() {
	s.resolveMu.Lock()
	s.resolveCache = map[string]resolvedEntry{}
	s.resolveMu.Unlock()
}
