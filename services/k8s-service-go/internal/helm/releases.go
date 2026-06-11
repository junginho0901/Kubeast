package helm

import (
	"context"
	"fmt"
	"sort"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/release"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// listCacheTTL bounds how stale the release-list response may be. Release
// mutations happen at human timescales (install/upgrade minutes apart),
// so 30s is a good trade between freshness and API pressure.
const listCacheTTL = 30 * time.Second

// ListReleases returns every release known to Helm in the cluster, or in
// the given namespace when non-empty. Results come from Helm's Secret
// storage driver — the call is fast (O(releases)) but we still cache it
// because the UI polls the list page.
//
// The status filter is applied by Helm SDK before the cache is consulted,
// so per-status queries are cached under distinct keys.
func (s *Service) ListReleases(ctx context.Context, namespace, status string) ([]ReleaseSummary, error) {
	// Scope the cache by cluster — otherwise one cluster's release list is served
	// for another (the list page would show the prior cluster's releases after a
	// switch, then 404 on click).
	clusterID := "default"
	if id, ok := cluster.FromContext(ctx); ok && id != "" {
		clusterID = string(id)
	}
	cacheKey := fmt.Sprintf("helm|releases|%s|%s|%s", clusterID, namespace, status)
	if s.cache != nil {
		var cached []ReleaseSummary
		if s.cache.Get(ctx, cacheKey, &cached) {
			return cached, nil
		}
	}

	// For cluster-wide listing, the Helm SDK requires an action config
	// initialized with an empty namespace AND AllNamespaces=true.
	cfg, err := s.actionConfig(ctx, namespace)
	if err != nil {
		return nil, err
	}

	lister := action.NewList(cfg)
	lister.All = true // include uninstalled-but-kept revisions
	lister.AllNamespaces = namespace == ""
	lister.SetStateMask()

	if status != "" {
		lister.StateMask = parseStateMask(status)
	}

	releases, err := lister.Run()
	if err != nil {
		return nil, translateSDKError(err)
	}

	out := make([]ReleaseSummary, 0, len(releases))
	for _, r := range releases {
		out = append(out, toSummary(r))
	}

	// Deterministic order: namespace then name. Helm itself returns
	// releases in storage-iteration order which is not stable.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})

	if s.cache != nil {
		s.cache.Set(ctx, cacheKey, out, listCacheTTL)
	}
	return out, nil
}

// invalidateListCache drops every cached release-list response. Called
// by write operations (rollback/upgrade/uninstall) once they land, so
// the next GET sees the post-mutation world.
func (s *Service) invalidateListCache(ctx context.Context) {
	if s.cache == nil {
		return
	}
	s.cache.DeletePattern(ctx, "helm|releases|*")
}

// toSummary extracts the list-view fields from a Helm *release.Release.
// Guard against partial data — the SDK sometimes returns releases whose
// Chart or Info pointer is nil for malformed storage entries.
func toSummary(r *release.Release) ReleaseSummary {
	s := ReleaseSummary{
		Name:      r.Name,
		Namespace: r.Namespace,
		Revision:  r.Version,
	}
	if r.Info != nil {
		s.Status = r.Info.Status.String()
		s.Updated = r.Info.LastDeployed.Time
		if s.Updated.IsZero() {
			s.Updated = r.Info.FirstDeployed.Time
		}
	}
	if r.Chart != nil && r.Chart.Metadata != nil {
		s.Chart = r.Chart.Metadata.Name
		s.ChartVersion = r.Chart.Metadata.Version
		s.AppVersion = r.Chart.Metadata.AppVersion
	}
	return s
}

// parseStateMask turns a status string (possibly comma-separated) into
// the bitmask Helm's lister expects. Unknown tokens are silently ignored
// — callers can assume "nothing was typoed" and get a broad result.
func parseStateMask(status string) action.ListStates {
	var mask action.ListStates
	for _, tok := range splitAndTrim(status, ',') {
		switch tok {
		case "deployed":
			mask |= action.ListDeployed
		case "uninstalled":
			mask |= action.ListUninstalled
		case "uninstalling":
			mask |= action.ListUninstalling
		case "pending", "pending-install":
			mask |= action.ListPendingInstall
		case "pending-upgrade":
			mask |= action.ListPendingUpgrade
		case "pending-rollback":
			mask |= action.ListPendingRollback
		case "superseded":
			mask |= action.ListSuperseded
		case "failed":
			mask |= action.ListFailed
		}
	}
	if mask == 0 {
		mask = action.ListAll
	}
	return mask
}

// splitAndTrim is a tiny helper to avoid pulling strings.Split just to
// immediately TrimSpace every token.
func splitAndTrim(s string, sep rune) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == sep {
			out = append(out, trimSpace(s[start:i]))
			start = i + 1
		}
	}
	out = append(out, trimSpace(s[start:]))
	return out
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
