package accessreview

import (
	"reflect"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

var now = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

func tp(t time.Time) *time.Time { return &t }
func sp(s string) *string       { return &s }

func sampleInput() Input {
	team := "sre"
	return Input{
		Users: []model.User{
			{ID: "u-admin", Email: "admin@example.com", Name: "Admin", RoleName: "Admin", AuthSource: "password", CreatedAt: now.AddDate(-1, 0, 0), LastLoginAt: tp(now.Add(-time.Hour))},
			{ID: "u-old", Email: "old@example.com", Name: "Old", Team: &team, RoleName: "Member", AuthSource: "oidc", CreatedAt: now.AddDate(-1, 0, 0), LastLoginAt: tp(now.AddDate(0, 0, -91))},
			{ID: "u-new", Email: "new@example.com", Name: "New", RoleName: "Member", AuthSource: "password", CreatedAt: now.AddDate(0, 0, -3)},
			{ID: "u-stale", Email: "stale@example.com", Name: "Stale", RoleName: "Member", AuthSource: "password", CreatedAt: now.AddDate(0, 0, -200), LockedUntil: tp(now.Add(10 * time.Minute))},
		},
		Grants: []repository.ReviewClusterGrant{
			{UserID: "u-old", UserEmail: "old@example.com", ClusterName: "prod", RoleID: 2, Role: "Read"},
			{UserID: "u-old", UserEmail: "old@example.com", ClusterName: "alpha", RoleID: 3, Role: "Write", ExpiresAt: tp(now.Add(2 * time.Hour)), RestoreRole: sp("Read"), RequestID: sp("req-1")},
			{UserID: "u-new", UserEmail: "new@example.com", ClusterName: "alpha", RoleID: 1, Role: "Admin"},
		},
		Keys: []repository.ReviewAPIKey{
			{OwnerEmail: "admin@example.com", APIKey: repository.APIKey{ID: "k1", UserID: "u-admin", Name: "ci", KeyPrefix: "kbk_a", RoleCeiling: "Read", CreatedAt: now.AddDate(0, 0, -40), ExpiresAt: now.AddDate(0, 0, 10)}},
			{OwnerEmail: "admin@example.com", APIKey: repository.APIKey{ID: "k2", UserID: "u-admin", Name: "used", KeyPrefix: "kbk_b", ClusterIDs: []string{"prod"}, RoleCeiling: "Write", CreatedAt: now.AddDate(0, 0, -40), ExpiresAt: now.AddDate(0, 0, 60), LastUsedAt: tp(now.Add(-time.Hour)), LastUsedIP: sp("10.0.0.1")}},
			{OwnerEmail: "old@example.com", APIKey: repository.APIKey{ID: "k3", UserID: "u-old", Name: "gone", KeyPrefix: "kbk_c", RoleCeiling: "Read", CreatedAt: now.AddDate(0, 0, -100), ExpiresAt: now.AddDate(0, 0, -1)}},
		},
		Requests: []repository.AccessRequest{
			{UserEmail: "old@example.com", ClusterName: "alpha", Role: "Write", DurationMinutes: 120, Reason: "deploy", Status: "approved", CreatedAt: now.Add(-3 * time.Hour),
				DecidedByEmail: sp("admin@example.com"), DecidedAt: tp(now.Add(-2 * time.Hour)), DecisionNote: sp("ok"), ExpiresAt: tp(now.Add(2 * time.Hour))},
		},
		Roles: []model.RoleWithPermissions{
			{Role: model.Role{ID: 1, Name: "Admin", IsSystem: true}, Permissions: []string{"*"}},
			{Role: model.Role{ID: 2, Name: "Read", IsSystem: true}, Permissions: []string{"resource.pod.read"}},
			{Role: model.Role{ID: 3, Name: "Write", IsSystem: true}, Permissions: []string{"resource.pod.read", "resource.pod.delete"}},
			{Role: model.Role{ID: 4, Name: "Member", IsSystem: true}, Permissions: []string{}},
			{Role: model.Role{ID: 5, Name: "Auditor", IsSystem: false}, Permissions: []string{"admin.audit.read"}},
		},
		UsersByRole:  map[int]int{1: 1, 4: 3},
		GrantsByRole: map[int]int{1: 1, 2: 1, 3: 1},
		LastReview:   &ReviewSummary{ID: "rev-1", ReviewedByEmail: "admin@example.com", ReviewedAt: now.AddDate(0, 0, -100), Note: "q2"},
	}
}

func TestBuildFlagsAndSummary(t *testing.T) {
	s := Settings{DormantDays: 90, IntervalDays: 90}
	rep := Build(now, s, DefaultSince(now, s, nil), sampleInput())

	flags := map[string][]string{}
	for _, u := range rep.Users {
		flags[u.Email] = u.Flags
	}
	want := map[string][]string{
		"admin@example.com": {FlagGlobalAdmin},
		"old@example.com":   {FlagDormant},
		"new@example.com":   {FlagNeverLoggedIn},
		"stale@example.com": {FlagNeverLoggedIn, FlagDormant, FlagLocked},
	}
	if !reflect.DeepEqual(flags, want) {
		t.Fatalf("user flags = %v, want %v", flags, want)
	}
	old := rep.Users[1]
	if old.Team != "sre" || old.ClusterRoles != 2 || old.TemporaryGrants != 1 || old.APIKeys != 0 {
		t.Errorf("old row: %+v", old)
	}
	if rep.Users[0].APIKeys != 2 {
		t.Errorf("admin should hold 2 active keys, got %d", rep.Users[0].APIKeys)
	}

	if rep.Summary != (Summary{Users: 4, GlobalAdmins: 1, Dormant: 2, NeverLoggedIn: 2, Locked: 1, ClusterGrants: 3, TemporaryGrants: 1,
		APIKeysActive: 2, APIKeysExpiring: 1, APIKeysUnused: 1, AccessRequests: 1}) {
		t.Errorf("summary = %+v", rep.Summary)
	}

	if g := rep.ClusterRoles[1]; g.GrantedVia != "request:req-1" || g.RestoreRole != "Read" || !reflect.DeepEqual(g.Flags, []string{FlagTemporary}) {
		t.Errorf("temporary grant row: %+v", g)
	}
	if g := rep.ClusterRoles[2]; g.GrantedVia != "permanent" || !reflect.DeepEqual(g.Flags, []string{FlagAdminRole}) {
		t.Errorf("admin grant row: %+v", g)
	}

	keyFlags := map[string][]string{}
	for _, k := range rep.APIKeys {
		keyFlags[k.Name] = k.Flags
	}
	if !reflect.DeepEqual(keyFlags, map[string][]string{"ci": {FlagExpiring30d, FlagUnused30d}, "used": {}, "gone": {FlagExpired}}) {
		t.Errorf("key flags = %v", keyFlags)
	}
	if rep.APIKeys[0].Clusters == nil || len(rep.APIKeys[1].Clusters) != 1 || rep.APIKeys[1].LastUsedIP != "10.0.0.1" {
		t.Errorf("key rows: %+v", rep.APIKeys)
	}

	if a := rep.AccessRequests[0]; a.DecidedByEmail != "admin@example.com" || a.DecisionNote != "ok" || a.Status != "approved" {
		t.Errorf("request row: %+v", a)
	}

	roleFlags := map[string][]string{}
	for _, r := range rep.Roles {
		roleFlags[r.Name] = r.Flags
	}
	if !reflect.DeepEqual(roleFlags, map[string][]string{"Admin": {FlagAdminPerms}, "Read": {}, "Write": {}, "Member": {}, "Auditor": {FlagAdminPerms, FlagUnusedRole}}) {
		t.Errorf("role flags = %v", roleFlags)
	}
	if rep.Roles[0].Users != 1 || rep.Roles[0].ClusterBindings != 1 || !reflect.DeepEqual(rep.Roles[2].Permissions, []string{"resource.pod.delete", "resource.pod.read"}) {
		t.Errorf("role rows: %+v", rep.Roles)
	}

	if rep.NextDueAt == nil || !rep.NextDueAt.Equal(now.AddDate(0, 0, -10)) || !rep.Overdue {
		t.Errorf("next due = %v overdue = %v", rep.NextDueAt, rep.Overdue)
	}
	if c := rep.Counts(); c["users"] != 4 || c["roles"] != 5 || c["dormant"] != 2 {
		t.Errorf("counts = %v", c)
	}
}

func TestBuildWithoutHistory(t *testing.T) {
	s := Settings{DormantDays: 90, IntervalDays: 90}
	in := sampleInput()
	in.LastReview = nil
	rep := Build(now, s, DefaultSince(now, s, nil), in)
	if rep.LastReview != nil || rep.NextDueAt != nil || rep.Overdue {
		t.Errorf("no history should give no due date: %+v %+v %v", rep.LastReview, rep.NextDueAt, rep.Overdue)
	}
	if !rep.Since.Equal(now.AddDate(0, 0, -90)) {
		t.Errorf("since = %v", rep.Since)
	}
	if since := DefaultSince(now, s, sampleInput().LastReview); !since.Equal(now.AddDate(0, 0, -100)) {
		t.Errorf("since with history = %v", since)
	}
	empty := Build(now, s, now, Input{})
	if empty.Users == nil || empty.ClusterRoles == nil || empty.APIKeys == nil || empty.AccessRequests == nil || empty.Roles == nil {
		t.Errorf("sections must be empty slices, not null: %+v", empty)
	}
}
