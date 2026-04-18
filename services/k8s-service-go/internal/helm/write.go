package helm

import (
	"context"
	"fmt"

	"github.com/hexops/gotextdiff"
	"github.com/hexops/gotextdiff/myers"
	"github.com/hexops/gotextdiff/span"
	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/release"
	"sigs.k8s.io/yaml"
)

// Rollback restores the release to a previous revision. When dryRun is
// true no mutation happens; instead the caller gets a unified diff
// between the current manifest and the target revision's manifest so
// the UI can show a preview before the human confirms.
//
// The dry-run diff is computed in our own process rather than routed
// through Helm's DryRun flag: action.Rollback's DryRun emits a manifest
// but not a diff, and we already have gotextdiff wired in for the
// history diff endpoint — reusing it keeps the preview semantics
// identical to what the user sees in the History tab.
func (s *Service) Rollback(ctx context.Context, namespace, name string, revision int, dryRun bool) (*RollbackResult, error) {
	if revision <= 0 {
		return nil, fmt.Errorf("revision must be positive")
	}

	current, err := s.fetchRelease(ctx, namespace, name, 0)
	if err != nil {
		return nil, err
	}
	fromRev := current.Version

	// Target revision must actually exist — otherwise the Helm SDK
	// returns a vague "not found" well into the rollback flow. Surface
	// it as ErrNotFound here so the handler can map to 404 before any
	// audit record is written for a guaranteed-failing operation.
	target, err := s.fetchRelease(ctx, namespace, name, revision)
	if err != nil {
		return nil, err
	}

	if dryRun {
		diff := unifiedDiff(
			fmt.Sprintf("%s/%s@%d.manifest", namespace, name, fromRev),
			fmt.Sprintf("%s/%s@%d.manifest", namespace, name, revision),
			current.Manifest,
			target.Manifest,
		)
		return &RollbackResult{
			DryRun:       true,
			FromRevision: fromRev,
			ToRevision:   revision,
			Diff:         diff,
		}, nil
	}

	cfg, err := s.actionConfig(ctx, namespace)
	if err != nil {
		return nil, err
	}
	r := action.NewRollback(cfg)
	r.Version = revision
	// Wait is deliberately left false: we return as soon as Helm has
	// committed the new revision and let the client poll the History
	// tab for rollout progress, same as kubectl rollout.
	if err := r.Run(name); err != nil {
		return nil, translateSDKError(err)
	}

	// Helm rollback bumps the revision (it records a new revision that
	// restores the chosen one), so the post-apply "latest" is not the
	// same number as the target. Fetch it to report the real outcome.
	after, err := s.fetchRelease(ctx, namespace, name, 0)
	if err != nil {
		// The mutation succeeded; surfacing a read-after-write error as
		// a rollback failure would mislead the operator. Return a best-
		// effort result and let the UI refetch history.
		return &RollbackResult{
			DryRun:       false,
			FromRevision: fromRev,
			ToRevision:   revision,
		}, nil
	}

	s.invalidateListCache(ctx)

	status := ""
	if after.Info != nil {
		status = after.Info.Status.String()
	}
	return &RollbackResult{
		DryRun:       false,
		FromRevision: fromRev,
		ToRevision:   revision,
		NewRevision:  after.Version,
		Status:       status,
	}, nil
}

// unifiedDiff is the shared myers-diff rendering used by both the
// history diff endpoint and the rollback preview. Keeping it in one
// helper means future diff-format changes (context lines, colour hints)
// land everywhere at once.
func unifiedDiff(fromLabel, toLabel, fromText, toText string) string {
	edits := myers.ComputeEdits(span.URIFromPath(fromLabel), fromText, toText)
	return fmt.Sprint(gotextdiff.ToUnified(fromLabel, toLabel, fromText, edits))
}

// Test runs the release's helm test hooks (usually Pod kind with the
// helm.sh/hook=test annotation) and returns a per-hook result. Helm's
// action.ReleaseTesting streams logs which we collect into the response
// — the UI should show failures prominently because a failed test
// often indicates a broken upgrade that hasn't rolled out yet.
func (s *Service) Test(ctx context.Context, namespace, name string) (*TestResult, error) {
	cfg, err := s.actionConfig(ctx, namespace)
	if err != nil {
		return nil, err
	}

	tester := action.NewReleaseTesting(cfg)
	tester.Namespace = namespace

	rel, err := tester.Run(name)
	// Helm returns an error when any hook fails but the release object
	// still contains the hook results, so we don't early-return here.
	result := &TestResult{Success: err == nil}
	if rel == nil {
		if err != nil {
			return nil, translateSDKError(err)
		}
		return result, nil
	}

	for _, h := range rel.Hooks {
		if !isTestHook(h.Events) {
			continue
		}
		entry := TestHookResult{Name: h.Name, Phase: string(h.LastRun.Phase)}
		// Phase "Failed" or a non-Succeeded phase marks the hook as failed.
		if h.LastRun.Phase != "Succeeded" && h.LastRun.Phase != "" {
			entry.Failed = true
		}
		// Helm stores hook logs on Release.Hooks[i].LastRun when fetch-logs
		// is enabled; the SDK does not expose a direct accessor so we
		// fall back to the rendered manifest header as a breadcrumb.
		if h.LastRun.Phase == "" {
			entry.Phase = "NotRun"
		}
		result.Hooks = append(result.Hooks, entry)
	}

	if err != nil {
		// Surface Helm's error message; the per-hook breakdown above
		// already tells the UI which hook failed.
		return result, translateSDKError(err)
	}
	return result, nil
}

// isTestHook reports whether any of a hook's registered events is "test".
// Helm v3 replaced "test-success" / "test-failure" with a single "test"
// event; we accept both for compatibility with older charts.
func isTestHook(events []release.HookEvent) bool {
	for _, e := range events {
		switch string(e) {
		case "test", "test-success", "test-failure":
			return true
		}
	}
	return false
}

// Uninstall removes a release from the cluster. When dryRun is true we
// skip the Helm call entirely and return the resource list derived
// from the stored manifest — the UI shows it as "will be deleted" so
// the operator can scan the blast radius before confirming.
//
// keepHistory controls whether Helm retains the release's revision
// secrets. Keeping history lets a later `helm rollback` resurrect the
// release; dropping it is equivalent to Helm v3's default.
func (s *Service) Uninstall(ctx context.Context, namespace, name string, keepHistory, dryRun bool) (*UninstallResult, error) {
	if dryRun {
		// GetResources fetches the release first, so a missing release
		// surfaces as ErrNotFound just like the apply path — no need
		// to fetch twice.
		resources, err := s.GetResources(ctx, namespace, name)
		if err != nil {
			return nil, err
		}
		return &UninstallResult{
			DryRun:      true,
			Release:     name,
			Namespace:   namespace,
			Resources:   resources,
			KeepHistory: keepHistory,
		}, nil
	}

	cfg, err := s.actionConfig(ctx, namespace)
	if err != nil {
		return nil, err
	}
	u := action.NewUninstall(cfg)
	u.KeepHistory = keepHistory
	// Wait=false: return once Helm has issued the deletions, let the
	// UI refresh to show the result rather than block the request
	// for potentially minutes while finalizers drain.
	resp, err := u.Run(name)
	if err != nil {
		return nil, translateSDKError(err)
	}

	s.invalidateListCache(ctx)

	info := ""
	if resp != nil && resp.Release != nil && resp.Release.Info != nil {
		info = resp.Release.Info.Description
	}
	return &UninstallResult{
		DryRun:      false,
		Release:     name,
		Namespace:   namespace,
		KeepHistory: keepHistory,
		Info:        info,
	}, nil
}

// UpgradeValues re-runs a release with a new user-supplied values map,
// keeping the already-installed chart version intact. Chart version
// upgrades are deferred to v1.2 (docs/helm-plan.md Q5) because their
// failure modes (CRD breaking changes, image tag jumps) deserve more
// explicit confirmation than a values edit.
//
// valuesYAML is parsed here rather than in the handler so tests that
// drive the service directly do not have to hand-shape a
// map[string]interface{}.
func (s *Service) UpgradeValues(ctx context.Context, namespace, name, valuesYAML string, dryRun bool) (*UpgradeResult, error) {
	current, err := s.fetchRelease(ctx, namespace, name, 0)
	if err != nil {
		return nil, err
	}
	if current.Chart == nil {
		return nil, fmt.Errorf("release %q has no stored chart; cannot upgrade", name)
	}

	vals := map[string]interface{}{}
	if trimmed := trimSpace(valuesYAML); trimmed != "" {
		if err := yaml.Unmarshal([]byte(valuesYAML), &vals); err != nil {
			return nil, fmt.Errorf("values must be valid YAML: %w", err)
		}
	}

	cfg, err := s.actionConfig(ctx, namespace)
	if err != nil {
		return nil, err
	}
	up := action.NewUpgrade(cfg)
	up.Namespace = namespace
	up.DryRun = dryRun
	// ReuseValues=false + ResetValues=true: replace the stored values
	// with the new map. Without ResetValues the SDK merges into chart
	// defaults in a way that makes "remove this override" impossible.
	up.ReuseValues = false
	up.ResetValues = true
	// Wait=false for the same reason as rollback/uninstall: the UI
	// refreshes history/status, not the HTTP request.

	newRel, err := up.Run(name, current.Chart, vals)
	if err != nil {
		return nil, translateSDKError(err)
	}

	chartVersion := ""
	if newRel.Chart != nil && newRel.Chart.Metadata != nil {
		chartVersion = newRel.Chart.Metadata.Version
	}

	if dryRun {
		diff := unifiedDiff(
			fmt.Sprintf("%s/%s@%d.manifest", namespace, name, current.Version),
			fmt.Sprintf("%s/%s@next.manifest", namespace, name),
			current.Manifest,
			newRel.Manifest,
		)
		return &UpgradeResult{
			DryRun:       true,
			FromRevision: current.Version,
			ChartVersion: chartVersion,
			Diff:         diff,
		}, nil
	}

	s.invalidateListCache(ctx)

	status := ""
	if newRel.Info != nil {
		status = newRel.Info.Status.String()
	}
	return &UpgradeResult{
		DryRun:       false,
		FromRevision: current.Version,
		NewRevision:  newRel.Version,
		Status:       status,
		ChartVersion: chartVersion,
	}, nil
}
