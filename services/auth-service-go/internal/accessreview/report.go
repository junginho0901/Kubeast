// Package accessreview builds the access review report: who has which access
// in this installation (accounts, per-cluster grants, API keys, the temporary
// grants requested and decided since the last review, the roles themselves)
// with the flags a reviewer looks for — dormant accounts, keys past or near
// expiry, privileged roles — and records that a review was signed off.
package accessreview

import (
	"sort"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

// Settings come from the chart (auth.accessReview.*).
type Settings struct {
	DormantDays  int `json:"dormant_days"`
	IntervalDays int `json:"interval_days"`
}

// Flags on report rows.
const (
	FlagGlobalAdmin   = "global_admin"
	FlagNeverLoggedIn = "never_logged_in"
	FlagDormant       = "dormant"
	FlagLocked        = "locked"
	FlagDormantLocked = "dormant_locked"
	FlagTemporary     = "temporary"
	FlagAdminRole     = "admin_role"
	FlagExpired       = "expired"
	FlagExpiring30d   = "expiring_30d"
	FlagUnused30d     = "unused_30d"
	FlagAdminPerms    = "has_admin_permissions"
	FlagUnusedRole    = "unused"
)

const (
	keyExpiringWindow = 30 * 24 * time.Hour
	keyUnusedAfter    = 30 * 24 * time.Hour
)

// ReviewSummary is the newest sign-off, without its snapshot.
type ReviewSummary struct {
	ID              string    `json:"id"`
	ReviewedByEmail string    `json:"reviewed_by_email"`
	ReviewedAt      time.Time `json:"reviewed_at"`
	Note            string    `json:"note"`
}

type UserRow struct {
	Email           string     `json:"email"`
	Name            string     `json:"name"`
	Team            string     `json:"team"`
	AuthSource      string     `json:"auth_source"`
	GlobalRole      string     `json:"global_role"`
	CreatedAt       time.Time  `json:"created_at"`
	LastLoginAt     *time.Time `json:"last_login_at"`
	LockedUntil     *time.Time `json:"locked_until,omitempty"`
	DormantLockedAt *time.Time `json:"dormant_locked_at,omitempty"`
	ClusterRoles    int        `json:"cluster_roles"`
	APIKeys         int        `json:"api_keys"`
	TemporaryGrants int        `json:"temporary_grants"`
	Flags           []string   `json:"flags"`
}

type ClusterRoleRow struct {
	UserEmail   string     `json:"user_email"`
	Cluster     string     `json:"cluster"`
	Role        string     `json:"role"`
	GrantedVia  string     `json:"granted_via"` // permanent | request:<id>
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	RestoreRole string     `json:"restore_role,omitempty"`
	Flags       []string   `json:"flags"`
}

type APIKeyRow struct {
	OwnerEmail  string     `json:"owner_email"`
	Name        string     `json:"name"`
	KeyPrefix   string     `json:"key_prefix"`
	Clusters    []string   `json:"clusters"` // empty = every cluster the owner reaches
	RoleCeiling string     `json:"role_ceiling"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	LastUsedIP  string     `json:"last_used_ip,omitempty"`
	Flags       []string   `json:"flags"`
}

type AccessRequestRow struct {
	RequesterEmail  string     `json:"requester_email"`
	Cluster         string     `json:"cluster"`
	Role            string     `json:"role"`
	DurationMinutes int        `json:"duration_minutes"`
	Reason          string     `json:"reason"`
	Status          string     `json:"status"`
	CreatedAt       time.Time  `json:"created_at"`
	DecidedByEmail  string     `json:"decided_by_email,omitempty"`
	DecidedAt       *time.Time `json:"decided_at,omitempty"`
	DecisionNote    string     `json:"decision_note,omitempty"`
	ExpiresAt       *time.Time `json:"expires_at,omitempty"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	EndReason       string     `json:"end_reason,omitempty"`
}

type RoleRow struct {
	Name            string   `json:"name"`
	IsSystem        bool     `json:"is_system"`
	Description     string   `json:"description"`
	Permissions     []string `json:"permissions"`
	Users           int      `json:"users"`
	ClusterBindings int      `json:"cluster_bindings"`
	Flags           []string `json:"flags"`
}

// Summary is what the cards on the page show.
type Summary struct {
	Users           int `json:"users"`
	GlobalAdmins    int `json:"global_admins"`
	Dormant         int `json:"dormant"`
	NeverLoggedIn   int `json:"never_logged_in"`
	Locked          int `json:"locked"`
	DormantLocked   int `json:"dormant_locked"`
	ClusterGrants   int `json:"cluster_grants"`
	TemporaryGrants int `json:"temporary_grants"`
	APIKeysActive   int `json:"api_keys_active"`
	APIKeysExpiring int `json:"api_keys_expiring"`
	APIKeysUnused   int `json:"api_keys_unused"`
	AccessRequests  int `json:"access_requests"`
}

// Report is the whole review as of GeneratedAt. Since bounds the access
// request section (default: since the last sign-off, else one interval back).
type Report struct {
	GeneratedAt    time.Time          `json:"generated_at"`
	Settings       Settings           `json:"settings"`
	Since          time.Time          `json:"since"`
	LastReview     *ReviewSummary     `json:"last_review"`
	NextDueAt      *time.Time         `json:"next_due_at"`
	Overdue        bool               `json:"overdue"`
	Summary        Summary            `json:"summary"`
	Users          []UserRow          `json:"users"`
	ClusterRoles   []ClusterRoleRow   `json:"cluster_roles"`
	APIKeys        []APIKeyRow        `json:"api_keys"`
	AccessRequests []AccessRequestRow `json:"access_requests"`
	Roles          []RoleRow          `json:"roles"`
}

// Input is everything Build reads, as the repository returns it.
type Input struct {
	Users        []model.User
	Grants       []repository.ReviewClusterGrant
	Keys         []repository.ReviewAPIKey
	Requests     []repository.AccessRequest
	Roles        []model.RoleWithPermissions
	UsersByRole  map[int]int
	GrantsByRole map[int]int
	LastReview   *ReviewSummary
}

// DefaultSince is the start of the access request window when there is no
// sign-off to count from: one interval back.
func DefaultSince(now time.Time, s Settings, last *ReviewSummary) time.Time {
	if last != nil {
		return last.ReviewedAt
	}
	return now.AddDate(0, 0, -s.IntervalDays)
}

// Build assembles the report; it reads nothing itself.
func Build(now time.Time, s Settings, since time.Time, in Input) *Report {
	rep := &Report{GeneratedAt: now.UTC(), Settings: s, Since: since.UTC(), LastReview: in.LastReview,
		Users: []UserRow{}, ClusterRoles: []ClusterRoleRow{}, APIKeys: []APIKeyRow{}, AccessRequests: []AccessRequestRow{}, Roles: []RoleRow{}}
	if in.LastReview != nil && s.IntervalDays > 0 {
		due := in.LastReview.ReviewedAt.AddDate(0, 0, s.IntervalDays)
		rep.NextDueAt = &due
		rep.Overdue = now.After(due)
	}

	privileged := map[string]bool{} // role name → carries "*" or admin.*
	for _, r := range in.Roles {
		privileged[r.Name] = hasAdminPermissions(r.Permissions)
	}
	grantsByUser, tempByUser := map[string]int{}, map[string]int{}
	for _, g := range in.Grants {
		grantsByUser[g.UserID]++
		if g.ExpiresAt != nil {
			tempByUser[g.UserID]++
		}
	}
	keysByUser := map[string]int{}
	for _, k := range in.Keys {
		if k.ExpiresAt.After(now) {
			keysByUser[k.UserID]++
		}
	}

	dormantBefore := now.AddDate(0, 0, -s.DormantDays)
	for _, u := range in.Users {
		row := UserRow{Email: u.Email, Name: u.Name, AuthSource: u.AuthSource, GlobalRole: u.RoleName, CreatedAt: u.CreatedAt.UTC(),
			LastLoginAt: utcPtr(u.LastLoginAt), ClusterRoles: grantsByUser[u.ID], APIKeys: keysByUser[u.ID], TemporaryGrants: tempByUser[u.ID], Flags: []string{}}
		if u.Team != nil {
			row.Team = *u.Team
		}
		if privileged[u.RoleName] {
			row.Flags = append(row.Flags, FlagGlobalAdmin)
			rep.Summary.GlobalAdmins++
		}
		if u.LastLoginAt == nil {
			row.Flags = append(row.Flags, FlagNeverLoggedIn)
			rep.Summary.NeverLoggedIn++
		}
		// Dormant counts from the last sign-in, or from creation for an account
		// that never signed in.
		ref := u.CreatedAt
		if u.LastLoginAt != nil {
			ref = *u.LastLoginAt
		}
		if s.DormantDays > 0 && !ref.After(dormantBefore) {
			row.Flags = append(row.Flags, FlagDormant)
			rep.Summary.Dormant++
		}
		if u.LockedUntil != nil && u.LockedUntil.After(now) {
			row.LockedUntil = utcPtr(u.LockedUntil)
			row.Flags = append(row.Flags, FlagLocked)
			rep.Summary.Locked++
		}
		if u.DormantLockedAt != nil {
			row.DormantLockedAt = utcPtr(u.DormantLockedAt)
			row.Flags = append(row.Flags, FlagDormantLocked)
			rep.Summary.DormantLocked++
		}
		rep.Users = append(rep.Users, row)
	}
	rep.Summary.Users = len(rep.Users)

	for _, g := range in.Grants {
		row := ClusterRoleRow{UserEmail: g.UserEmail, Cluster: g.ClusterName, Role: g.Role, GrantedVia: "permanent", ExpiresAt: utcPtr(g.ExpiresAt), Flags: []string{}}
		if g.RequestID != nil && *g.RequestID != "" {
			row.GrantedVia = "request:" + *g.RequestID
		}
		if g.RestoreRole != nil {
			row.RestoreRole = *g.RestoreRole
		}
		if g.ExpiresAt != nil {
			row.Flags = append(row.Flags, FlagTemporary)
			rep.Summary.TemporaryGrants++
		}
		if privileged[g.Role] {
			row.Flags = append(row.Flags, FlagAdminRole)
		}
		rep.ClusterRoles = append(rep.ClusterRoles, row)
	}
	rep.Summary.ClusterGrants = len(rep.ClusterRoles)

	for _, k := range in.Keys {
		row := APIKeyRow{OwnerEmail: k.OwnerEmail, Name: k.Name, KeyPrefix: k.KeyPrefix, Clusters: k.ClusterIDs, RoleCeiling: k.RoleCeiling,
			CreatedAt: k.CreatedAt.UTC(), ExpiresAt: k.ExpiresAt.UTC(), LastUsedAt: utcPtr(k.LastUsedAt), Flags: []string{}}
		if row.Clusters == nil {
			row.Clusters = []string{}
		}
		if k.LastUsedIP != nil {
			row.LastUsedIP = *k.LastUsedIP
		}
		switch {
		case !k.ExpiresAt.After(now):
			row.Flags = append(row.Flags, FlagExpired)
		case k.ExpiresAt.Sub(now) <= keyExpiringWindow:
			row.Flags = append(row.Flags, FlagExpiring30d)
			rep.Summary.APIKeysActive++
			rep.Summary.APIKeysExpiring++
		default:
			rep.Summary.APIKeysActive++
		}
		if k.LastUsedAt == nil && k.ExpiresAt.After(now) && now.Sub(k.CreatedAt) >= keyUnusedAfter {
			row.Flags = append(row.Flags, FlagUnused30d)
			rep.Summary.APIKeysUnused++
		}
		rep.APIKeys = append(rep.APIKeys, row)
	}

	for _, a := range in.Requests {
		row := AccessRequestRow{RequesterEmail: a.UserEmail, Cluster: a.ClusterName, Role: a.Role, DurationMinutes: a.DurationMinutes, Reason: a.Reason,
			Status: a.Status, CreatedAt: a.CreatedAt.UTC(), DecidedAt: utcPtr(a.DecidedAt), ExpiresAt: utcPtr(a.ExpiresAt), EndedAt: utcPtr(a.EndedAt)}
		row.DecidedByEmail = deref(a.DecidedByEmail)
		row.DecisionNote = deref(a.DecisionNote)
		row.EndReason = deref(a.EndReason)
		rep.AccessRequests = append(rep.AccessRequests, row)
	}
	rep.Summary.AccessRequests = len(rep.AccessRequests)

	for _, r := range in.Roles {
		perms := append([]string{}, r.Permissions...)
		sort.Strings(perms)
		row := RoleRow{Name: r.Name, IsSystem: r.IsSystem, Description: r.Description, Permissions: perms,
			Users: in.UsersByRole[r.ID], ClusterBindings: in.GrantsByRole[r.ID], Flags: []string{}}
		if privileged[r.Name] {
			row.Flags = append(row.Flags, FlagAdminPerms)
		}
		if !r.IsSystem && row.Users == 0 && row.ClusterBindings == 0 {
			row.Flags = append(row.Flags, FlagUnusedRole)
		}
		rep.Roles = append(rep.Roles, row)
	}
	return rep
}

// hasAdminPermissions: the superuser wildcard or any admin.* permission.
func hasAdminPermissions(perms []string) bool {
	for _, p := range perms {
		if p == "*" || strings.HasPrefix(p, "admin.") {
			return true
		}
	}
	return false
}

// Counts is what a sign-off stores next to the snapshot.
func (r *Report) Counts() map[string]int {
	return map[string]int{
		"users": r.Summary.Users, "global_admins": r.Summary.GlobalAdmins, "dormant": r.Summary.Dormant, "never_logged_in": r.Summary.NeverLoggedIn,
		"locked": r.Summary.Locked, "dormant_locked": r.Summary.DormantLocked, "cluster_grants": r.Summary.ClusterGrants, "temporary_grants": r.Summary.TemporaryGrants,
		"api_keys_active": r.Summary.APIKeysActive, "api_keys_expiring": r.Summary.APIKeysExpiring, "api_keys_unused": r.Summary.APIKeysUnused,
		"access_requests": r.Summary.AccessRequests, "roles": len(r.Roles),
	}
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
