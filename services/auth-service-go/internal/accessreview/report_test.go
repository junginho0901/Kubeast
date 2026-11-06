package accessreview

import (
	"reflect"
	"slices"
	"strings"
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

	if rep.Summary != (Summary{Users: 4, GlobalAdmins: 1, FullAdmins: 1, Dormant: 2, NeverLoggedIn: 2, Locked: 1, ClusterGrants: 3, TemporaryGrants: 1,
		APIKeysActive: 2, APIKeysExpiring: 1, APIKeysUnused: 1, AccessRequests: 1}) {
		t.Errorf("summary = %+v", rep.Summary)
	}

	if g := rep.ClusterRoles[1]; g.GrantedVia != "request:req-1" || g.RestoreRole != "Read" || !reflect.DeepEqual(g.Flags, []string{FlagTemporary}) {
		t.Errorf("temporary grant row: %+v", g)
	}
	if g := rep.ClusterRoles[2]; g.GrantedVia != "permanent" || !reflect.DeepEqual(g.Flags, []string{FlagAdminRole, FlagSensitiveAccess}) {
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
	if !reflect.DeepEqual(roleFlags, map[string][]string{"Admin": {FlagAdminPerms, FlagSensitiveAccess}, "Read": {}, "Write": {}, "Member": {}, "Auditor": {FlagAdminPerms, FlagUnusedRole}}) {
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

// Dormant is what the dormant lock reads (repository.LockDormantAccounts): the
// later of the last sign-in and the newest use of any key (expired ones too),
// each counted from creation when missing. An account kept active by a key
// only is not dormant and says so; one that never signed in stays "never
// signed in". Admin accounts are counted, and flagged when the lock leaves
// them alone.
func TestBuildDormantIsWhatTheLockReads(t *testing.T) {
	user := func(id, role string, created time.Time, login *time.Time) model.User {
		return model.User{ID: id, Email: id + "@example.com", RoleName: role, CreatedAt: created, LastLoginAt: login}
	}
	key := func(id, user string, expires time.Time, used *time.Time) repository.ReviewAPIKey {
		return repository.ReviewAPIKey{OwnerEmail: user + "@example.com", APIKey: repository.APIKey{ID: id, UserID: user, Name: id, RoleCeiling: "Read", CreatedAt: now.AddDate(0, 0, -300), ExpiresAt: expires, LastUsedAt: used}}
	}
	old := now.AddDate(0, 0, -200)
	in := Input{
		Users: []model.User{
			user("key-only", "Member", old, nil),                    // never signed in, key used an hour ago
			user("old-login-key", "Member", old, tp(old)),           // signed in long ago, an expired key used 10 days ago
			user("old-login-old-key", "Member", old, tp(old)),       // its key's last use is 120 days ago
			user("auditor", "Auditor", old, tp(old)),                // admin.audit.read, nothing since
			user("admin", "Admin", old, tp(now.AddDate(0, 0, -91))), // "*", nothing for 91 days
			user("fresh", "Member", now.AddDate(0, 0, -3), nil),     // new, never signed in
			user("stale", "Member", old, nil),                       // never signed in, no key
			user("edge", "Member", old, tp(now.AddDate(0, 0, -90))), // exactly at the cutoff: the lock's "<" leaves it
		},
		Keys: []repository.ReviewAPIKey{
			key("k1", "key-only", now.AddDate(0, 0, 30), tp(now.Add(-time.Hour))),
			key("k2", "old-login-key", now.AddDate(0, 0, -1), tp(now.AddDate(0, 0, -10))),
			key("k3", "old-login-old-key", now.AddDate(0, 0, 30), tp(now.AddDate(0, 0, -120))),
			key("k4", "old-login-old-key", now.AddDate(0, 0, 30), nil),
		},
		Roles: []model.RoleWithPermissions{
			{Role: model.Role{ID: 1, Name: "Admin"}, Permissions: []string{"*"}},
			{Role: model.Role{ID: 4, Name: "Member"}, Permissions: []string{}},
			{Role: model.Role{ID: 5, Name: "Auditor"}, Permissions: []string{"admin.audit.read"}},
		},
	}
	flagsOf := func(rep *Report) map[string][]string {
		out := map[string][]string{}
		for _, u := range rep.Users {
			out[u.Email[:len(u.Email)-len("@example.com")]] = u.Flags
		}
		return out
	}

	off := Build(now, Settings{DormantDays: 90}, now, in)
	want := map[string][]string{
		"key-only":          {FlagNeverLoggedIn, FlagAPIKeyOnly},
		"old-login-key":     {FlagAPIKeyOnly},
		"old-login-old-key": {FlagDormant},
		"auditor":           {FlagGlobalAdmin, FlagDormant},
		"admin":             {FlagGlobalAdmin, FlagDormant},
		"fresh":             {FlagNeverLoggedIn},
		"stale":             {FlagNeverLoggedIn, FlagDormant},
		"edge":              {},
	}
	if got := flagsOf(off); !reflect.DeepEqual(got, want) {
		t.Errorf("lock off: flags = %v\nwant %v", got, want)
	}
	if off.Summary.Dormant != 4 || off.Summary.NeverLoggedIn != 3 || off.Summary.GlobalAdmins != 2 || off.Summary.FullAdmins != 1 {
		t.Errorf("lock off: summary = %+v", off.Summary)
	}

	on := Build(now, Settings{DormantDays: 90, LockEnabled: true, LockDays: 90, LockExemptAdmins: true}, now, in)
	got := flagsOf(on)
	if !reflect.DeepEqual(got["auditor"], []string{FlagGlobalAdmin, FlagDormant, FlagLockExempt}) || !reflect.DeepEqual(got["admin"], []string{FlagGlobalAdmin, FlagDormant, FlagLockExempt}) {
		t.Errorf("lock on, admins exempt: auditor %v admin %v", got["auditor"], got["admin"])
	}
	if !reflect.DeepEqual(got["stale"], want["stale"]) || on.Summary.Dormant != 4 {
		t.Errorf("lock on: stale %v, dormant %d — the exempt admins are still counted", got["stale"], on.Summary.Dormant)
	}
	noExempt := Build(now, Settings{DormantDays: 90, LockEnabled: true, LockDays: 90}, now, in)
	if f := flagsOf(noExempt)["auditor"]; !reflect.DeepEqual(f, []string{FlagGlobalAdmin, FlagDormant}) {
		t.Errorf("lock on without the exemption: auditor %v", f)
	}
	if none := Build(now, Settings{}, now, in); none.Summary.Dormant != 0 || flagsOf(none)["key-only"][len(flagsOf(none)["key-only"])-1] != FlagNeverLoggedIn {
		t.Errorf("dormant days 0: %+v %v", none.Summary, flagsOf(none)["key-only"])
	}
}

func TestLastActivityIsTheLocksGreatest(t *testing.T) {
	created := now.AddDate(0, 0, -300)
	signIn := now.AddDate(0, 0, -100)
	keyUse := now.AddDate(0, 0, -50)
	cases := []struct {
		login *time.Time
		key   time.Time
		want  time.Time
	}{
		{nil, time.Time{}, created},    // GREATEST(created, created)
		{&signIn, time.Time{}, signIn}, // GREATEST(login, created)
		{nil, keyUse, keyUse},          // GREATEST(created, key)
		{&signIn, keyUse, keyUse},      // GREATEST(login, key)
		{&keyUse, signIn.AddDate(0, 0, -1), keyUse},
	}
	for i, c := range cases {
		if got := lastActivity(model.User{CreatedAt: created, LastLoginAt: c.login}, c.key); !got.Equal(c.want) {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
}

// "With admin permissions" counts every account whose global role carries "*"
// or an admin.* permission; the global admins beside it are the "*" ones.
func TestBuildFullAdmins(t *testing.T) {
	in := Input{
		Users: []model.User{
			{ID: "1", Email: "a@x", RoleName: "Admin", CreatedAt: now},
			{ID: "2", Email: "b@x", RoleName: "Auditor", CreatedAt: now},
			{ID: "3", Email: "c@x", RoleName: "Ops", CreatedAt: now},
			{ID: "4", Email: "d@x", RoleName: "Member", CreatedAt: now},
		},
		Roles: []model.RoleWithPermissions{
			{Role: model.Role{Name: "Admin"}, Permissions: []string{"*"}},
			{Role: model.Role{Name: "Auditor"}, Permissions: []string{"admin.audit.read"}},
			{Role: model.Role{Name: "Ops"}, Permissions: []string{"resource.pod.read", "*"}},
			{Role: model.Role{Name: "Member"}, Permissions: []string{"resource.pod.read"}},
		},
	}
	rep := Build(now, Settings{DormantDays: 90}, now, in)
	if rep.Summary.GlobalAdmins != 3 || rep.Summary.FullAdmins != 2 {
		t.Errorf("with admin permissions %d (want 3), global admins %d (want 2)", rep.Summary.GlobalAdmins, rep.Summary.FullAdmins)
	}
	if c := rep.Counts(); c["global_admins"] != 3 || c["full_admins"] != 2 {
		t.Errorf("counts = %v", c)
	}
}

// The request section holds the newest rows up to the read's limit; the
// report says how many there are.
func TestBuildAccessRequestsTotal(t *testing.T) {
	in := sampleInput()
	in.RequestsTotal = 5001
	if rep := Build(now, Settings{}, now, in); rep.AccessRequestsTotal != 5001 || len(rep.AccessRequests) != 1 {
		t.Errorf("total %d rows %d", rep.AccessRequestsTotal, len(rep.AccessRequests))
	}
	in.RequestsTotal = 0
	if rep := Build(now, Settings{}, now, in); rep.AccessRequestsTotal != 1 {
		t.Errorf("a total below the rows read = %d, want the rows (1)", rep.AccessRequestsTotal)
	}
}

// A role can reach a node's shell, a pod's exec or Secret values without any
// admin.* key, and a reviewer must see that on the row. The admin flags keep
// their meaning, so a card counting them does not move.
func TestReportMarksRolesThatReachShellsExecAndSecrets(t *testing.T) {
	const flag = "sensitive_access"
	for _, c := range []struct {
		perms     []string
		sensitive bool
		admin     bool
	}{
		{[]string{"resource.*"}, true, false},
		{[]string{"resource.*.*"}, true, false},
		{[]string{"resource.node.shell"}, true, false},
		{[]string{"resource.node.*"}, true, false},
		{[]string{"resource.pod.exec"}, true, false},
		{[]string{"resource.pod.*"}, true, false},
		{[]string{"resource.secret.reveal"}, true, false},
		{[]string{"menu.dashboard", "resource.pod.read", "resource.secret.reveal"}, true, false},
		{[]string{"*"}, true, true},
		{[]string{"admin.audit.read", "resource.pod.exec"}, true, true},
		{[]string{"admin.*"}, false, true},
		{[]string{"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete"}, false, false},
		{[]string{"resource.pod.logfile", "resource.pod.read"}, false, false},
		{[]string{"menu.*", "ai.tool.*", "ai.mcp.use"}, false, false},
		{nil, false, false},
	} {
		t.Run(strings.Join(c.perms, ","), func(t *testing.T) {
			s := Settings{DormantDays: 90, IntervalDays: 90}
			rep := Build(now, s, now, Input{
				Users:  []model.User{{ID: "u", Email: "u@example.com", RoleName: "probe", CreatedAt: now, LastLoginAt: &now}},
				Grants: []repository.ReviewClusterGrant{{UserID: "u", UserEmail: "u@example.com", ClusterName: "c", RoleID: 9, Role: "probe"}},
				Roles:  []model.RoleWithPermissions{{Role: model.Role{ID: 9, Name: "probe"}, Permissions: c.perms}},
			})
			if got := slices.Contains(rep.Roles[0].Flags, flag); got != c.sensitive {
				t.Errorf("role row flags %v, want %s = %v", rep.Roles[0].Flags, flag, c.sensitive)
			}
			if got := slices.Contains(rep.ClusterRoles[0].Flags, flag); got != c.sensitive {
				t.Errorf("grant row flags %v, want %s = %v", rep.ClusterRoles[0].Flags, flag, c.sensitive)
			}
			if got := slices.Contains(rep.Roles[0].Flags, FlagAdminPerms); got != c.admin {
				t.Errorf("role row flags %v, want %s = %v", rep.Roles[0].Flags, FlagAdminPerms, c.admin)
			}
			if got := slices.Contains(rep.ClusterRoles[0].Flags, FlagAdminRole); got != c.admin {
				t.Errorf("grant row flags %v, want %s = %v", rep.ClusterRoles[0].Flags, FlagAdminRole, c.admin)
			}
			if rep.Summary.GlobalAdmins != boolCount(c.admin) {
				t.Errorf("global admins = %d, want %d", rep.Summary.GlobalAdmins, boolCount(c.admin))
			}
			// A global role's resource keys are not in the token: on the account's
			// row the flag would claim something the account cannot do.
			if slices.Contains(rep.Users[0].Flags, flag) {
				t.Errorf("user row flags %v must not carry %s", rep.Users[0].Flags, flag)
			}
		})
	}
}

func boolCount(b bool) int {
	if b {
		return 1
	}
	return 0
}
