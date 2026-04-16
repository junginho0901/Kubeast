// Package audit provides a shared audit-log recording API used by all
// Kubeast Go services (auth, k8s, helm, ...).
//
// See docs/audit-log-plan.md for the full design and action-naming rules.
package audit

import (
	"encoding/json"
	"time"
)

// Service identifiers. Use these constants instead of raw strings when
// constructing a Record to avoid typos.
const (
	ServiceAuth  = "auth"
	ServiceK8s   = "k8s"
	ServiceHelm  = "helm"
	ServiceAI    = "ai"
	ServiceAdmin = "admin"
)

// Result values for Record.Result.
const (
	ResultSuccess = "success"
	ResultFailure = "failure"
)

// Record is the canonical audit-log entry written by any service.
//
// Action keys follow the convention "<domain>.<object>.<verb>"
// (e.g. "helm.release.rollback", "k8s.pod.delete"). See the catalog
// in docs/audit-log-plan.md §5-2.
type Record struct {
	// Identity
	Service string // ServiceAuth | ServiceK8s | ServiceHelm | ServiceAI | ServiceAdmin
	Action  string // "<domain>.<object>.<verb>"

	// Actor — the authenticated user who initiated the action
	ActorUserID string
	ActorEmail  string

	// Target — what the action operated on (optional)
	TargetID    string // resource identifier (release name, pod name, user id, ...)
	TargetType  string // "release" | "pod" | "deployment" | "user" | ...
	TargetEmail string // populated when TargetType == "user"

	// Scope
	Cluster   string // "default" — multi-cluster ready
	Namespace string // K8s namespace (when applicable)

	// Payload — arbitrary before/after snapshots.
	// Sensitive fields MUST be masked before assignment (see helper.MaskSensitive).
	Before json.RawMessage
	After  json.RawMessage

	// Result
	Result string // ResultSuccess | ResultFailure. Empty defaults to success on write.
	Error  string // populated only when Result == ResultFailure

	// HTTP context
	RequestIP string
	UserAgent string
	RequestID string
	Path      string
}

// Entry is a persisted Record returned from a read query.
type Entry struct {
	Record
	ID        int64
	CreatedAt time.Time
}

// Filter narrows a List query. Zero-valued fields are ignored.
type Filter struct {
	Service    string
	Action     string
	ActorEmail string
	TargetID   string
	Cluster    string
	Namespace  string
	Result     string // ResultSuccess | ResultFailure
	Since      time.Time
	Until      time.Time
	Limit      int // default 100, max 1000
	Offset     int
}
