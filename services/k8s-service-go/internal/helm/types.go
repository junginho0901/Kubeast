package helm

import "time"

// ReleaseSummary is the minimal view of a Helm release used in list pages.
// Keep fields explicit (JSON-tagged) — the frontend consumes this shape
// directly and we do not want accidental field leakage from the SDK types.
type ReleaseSummary struct {
	Name         string    `json:"name"`
	Namespace    string    `json:"namespace"`
	Revision     int       `json:"revision"`
	Status       string    `json:"status"`
	Chart        string    `json:"chart"`
	ChartVersion string    `json:"chartVersion"`
	AppVersion   string    `json:"appVersion"`
	Updated      time.Time `json:"updated"`
}

// ReleaseDetail extends ReleaseSummary with fields that are expensive to
// render for every row but cheap for a detail view.
type ReleaseDetail struct {
	ReleaseSummary
	Description string                 `json:"description"`
	Values      map[string]interface{} `json:"values,omitempty"`
	Notes       string                 `json:"notes,omitempty"`
	Manifest    string                 `json:"manifest,omitempty"`
}

// HistoryEntry represents one revision in a release's history. Only the
// metadata is included — manifests and values are fetched per-revision
// on demand to keep the history response small.
type HistoryEntry struct {
	Revision     int       `json:"revision"`
	Status       string    `json:"status"`
	ChartVersion string    `json:"chartVersion"`
	AppVersion   string    `json:"appVersion"`
	Updated      time.Time `json:"updated"`
	Description  string    `json:"description"`
}

// SectionKind enumerates the release sections that can be retrieved
// independently of the full release detail. The values are stable and
// become part of the URL — do not rename without an API version bump.
type SectionKind string

const (
	SectionManifest SectionKind = "manifest"
	SectionValues   SectionKind = "values"
	SectionNotes    SectionKind = "notes"
	SectionHooks    SectionKind = "hooks"
)

// IsValid reports whether s is a supported section kind.
func (s SectionKind) IsValid() bool {
	switch s {
	case SectionManifest, SectionValues, SectionNotes, SectionHooks:
		return true
	}
	return false
}

// DiffRequest is the payload for diffing two revisions of the same release.
type DiffRequest struct {
	From    int         `json:"from"`
	To      int         `json:"to"`
	Section SectionKind `json:"section"`
}

// DiffResult is the unified-diff output plus enough context for the UI
// to label which side is which.
type DiffResult struct {
	From    int         `json:"from"`
	To      int         `json:"to"`
	Section SectionKind `json:"section"`
	Diff    string      `json:"diff"`
}

// ReleaseResource is one Kubernetes resource that a Helm release created.
// Enough fields to link back into the existing resource drawer — not a
// full resource representation.
type ReleaseResource struct {
	Kind       string `json:"kind"`
	APIVersion string `json:"apiVersion"`
	Name       string `json:"name"`
	Namespace  string `json:"namespace,omitempty"`
}

// RollbackRequest is the JSON body for the rollback endpoint.
type RollbackRequest struct {
	Revision int  `json:"revision"`
	DryRun   bool `json:"dryRun"`
}

// RollbackResult covers both the dry-run and the apply responses from
// the rollback endpoint. The DryRun flag distinguishes which fields the
// caller should inspect — Diff only makes sense when DryRun is true,
// NewRevision only when it is false.
type RollbackResult struct {
	DryRun       bool   `json:"dryRun"`
	FromRevision int    `json:"fromRevision"`
	ToRevision   int    `json:"toRevision"`
	NewRevision  int    `json:"newRevision,omitempty"`
	Status       string `json:"status,omitempty"`
	Diff         string `json:"diff,omitempty"`
}

// UninstallResult mirrors RollbackResult's dual-mode shape. On dry-run
// the caller gets the list of resources that would be deleted (taken
// from the release manifest); on apply, Info carries Helm's own
// post-uninstall description when available.
type UninstallResult struct {
	DryRun      bool              `json:"dryRun"`
	Release     string            `json:"release"`
	Namespace   string            `json:"namespace"`
	Resources   []ReleaseResource `json:"resources,omitempty"`
	KeepHistory bool              `json:"keepHistory"`
	Info        string            `json:"info,omitempty"`
}

// UpgradeValuesRequest carries the YAML-encoded values map the user
// wants to apply. The server parses it — keeping it as a string on the
// wire means the frontend sends exactly what the user typed (including
// comment-preserving edits, if we later adopt a round-tripper).
type UpgradeValuesRequest struct {
	Values string `json:"values"`
	DryRun bool   `json:"dryRun"`
}

// UpgradeResult follows the same dual-mode convention as RollbackResult.
// The chart version is reported (unchanged in v1.1, Q5) so the UI can
// surface the fact that this was a values-only upgrade.
type UpgradeResult struct {
	DryRun       bool   `json:"dryRun"`
	FromRevision int    `json:"fromRevision"`
	NewRevision  int    `json:"newRevision,omitempty"`
	Status       string `json:"status,omitempty"`
	Diff         string `json:"diff,omitempty"`
	ChartVersion string `json:"chartVersion"`
}

// TestResult captures the outcome of running the helm test hooks for a
// release. Logs are included so the UI can show failure output without
// a second round-trip.
type TestResult struct {
	Success bool            `json:"success"`
	Hooks   []TestHookResult `json:"hooks"`
}

// TestHookResult is one per test hook (usually a Pod). Name + phase let
// the UI render a per-hook status badge; Logs is the pod stdout/stderr.
type TestHookResult struct {
	Name   string `json:"name"`
	Phase  string `json:"phase"`
	Logs   string `json:"logs,omitempty"`
	Failed bool   `json:"failed"`
}
