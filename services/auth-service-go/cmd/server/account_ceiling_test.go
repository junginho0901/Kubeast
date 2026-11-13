package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	roleMember      = 1
	roleRead        = 3
	roleAdmin       = 10
	roleUserAdmin   = 11
	roleAuditor     = 12
	roleClusterKeys = 13
	roleCustom      = 7
	roleStoredAdmin = 8

	userAdminPerm   = "admin.users.update"
	userDeletePerm  = "admin.users.delete"
	roleUpdatePerm  = "admin.roles.update"
	roleCreatePerm  = "admin.roles.create"
	widerClusterKey = "resource.*.delete"
)

var (
	textOID    = uint32(pgtype.TextOID)
	integerOID = uint32(pgtype.Int4OID)
	stampOID   = uint32(pgtype.TimestamptzOID)
	listOID    = uint32(pgtype.TextArrayOID)
	booleanOID = uint32(pgtype.BoolOID)
)

func pgNow() string { return time.Now().UTC().Format(pgTimestamp) }

// grantOn is one row of user_cluster_roles; a nil namespaces is the whole cluster.
type grantOn struct {
	cluster    string
	roleID     int
	namespaces any
}

// accountRules makes the database answer for an account the way token issue
// and the admin routes read it.
func accountRules(id string, roleID int, roleName string, grants ...grantOn) []pgRule {
	account := pgRule{
		match: fmt.Sprintf("u.role_id WHERE u.id =  '%s'", id),
		oids:  []uint32{textOID, textOID, textOID, textOID, integerOID, textOID, textOID, integerOID, textOID, stampOID, stampOID, stampOID, stampOID, stampOID},
		rows:  [][]any{{id, id, id + "@example.com", nil, roleID, roleName, "x", 0, "password", pgNow(), pgNow(), nil, nil, nil}},
	}
	matrix := pgRule{match: fmt.Sprintf("namespaces FROM user_cluster_roles WHERE user_id =  '%s'", id), oids: []uint32{textOID, integerOID, listOID}}
	scoped := pgRule{match: fmt.Sprintf("user_id =  '%s'  AND namespaces IS NOT NULL", id), oids: []uint32{textOID, listOID}}
	for _, g := range grants {
		matrix.rows = append(matrix.rows, []any{g.cluster, g.roleID, g.namespaces})
		if g.namespaces != nil {
			scoped.rows = append(scoped.rows, []any{g.cluster, g.namespaces})
		}
	}
	return []pgRule{account, matrix, scoped}
}

func permsRule(roleID int, perms ...string) pgRule {
	rule := pgRule{match: fmt.Sprintf("FROM role_permissions WHERE role_id =  '%d' ", roleID), oids: []uint32{textOID}}
	for _, p := range perms {
		rule.rows = append(rule.rows, []any{p})
	}
	return rule
}

func roleRule(roleID int, name string, system bool) pgRule {
	return pgRule{
		match: fmt.Sprintf("FROM roles WHERE id =  '%d' ", roleID),
		oids:  []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
		rows:  [][]any{{roleID, name, "", system, pgNow(), pgNow()}},
	}
}

func accountFixture() []pgRule {
	rules := []pgRule{
		permsRule(roleMember),
		permsRule(roleRead, readPerm),
		permsRule(roleAdmin, "*"),
		permsRule(roleUserAdmin, userAdminPerm, userDeletePerm),
		permsRule(roleAuditor, "admin.audit.read"),
		permsRule(roleClusterKeys, "menu.dashboard", widerClusterKey),
		roleRule(roleMember, "Member", true),
		roleRule(roleAdmin, "Admin", true),
		{match: "FROM roles WHERE name =  'Admin'", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{roleAdmin, "Admin", "", true, pgNow(), pgNow()}}},
	}
	for _, a := range [][]pgRule{
		accountRules("root", roleAdmin, "Admin"),
		accountRules("auditor", roleAuditor, "Auditor"),
		accountRules("cluster-admin", roleMember, "Member", grantOn{"c", roleAdmin, nil}),
		accountRules("elsewhere", roleMember, "Member", grantOn{"d", roleAdmin, nil}),
		accountRules("plain", roleMember, "Member"),
		accountRules("peer", roleUserAdmin, "UserAdmin"),
		accountRules("reader", roleMember, "Member", grantOn{"c", roleRead, nil}),
		accountRules("team-a-reader", roleMember, "Member", grantOn{"c", roleRead, "{team-a}"}),
		accountRules("global-cluster-keys", roleClusterKeys, "ClusterKeys"),
		accountRules("actor", roleAdmin, "Admin"),
	} {
		rules = append(rules, a...)
	}
	return rules
}

func (a *authAPI) actor(perms auth.PermissionMatrix, namespaces map[string][]string) string {
	a.t.Helper()
	tok, err := a.mgr.CreateToken("actor", "actor@example.com", "Member", perms, map[string]string{}, namespaces, 0)
	if err != nil {
		a.t.Fatal(err)
	}
	return tok
}

// userAdmin manages users and holds the read key on cluster c.
var userAdmin = auth.PermissionMatrix{"*": {userAdminPerm, userDeletePerm}, "c": {readPerm}}

// clusterAdmin manages users and is Admin on cluster c.
var clusterAdmin = auth.PermissionMatrix{"*": {userAdminPerm, userDeletePerm}, "c": {"*"}}

var (
	globalAdmin      = auth.PermissionMatrix{"*": {"*"}}
	namespaceLimited = map[string][]string{"c": {"team-a"}}
)

type accountChange struct {
	name, method, path, body, action, write string
	ok                                      int
}

func wantRefused(t *testing.T, api *authAPI, w *httptest.ResponseRecorder, change accountChange, target string) {
	t.Helper()
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "permission ceiling") {
		t.Fatalf("%d %s, want 403 naming the permission ceiling", w.Code, w.Body.String())
	}
	if api.db.ran(change.write) {
		t.Errorf("%q reached the database", change.write)
	}
	rows := api.store.failures(change.action)
	if len(rows) != 1 || rows[0].TargetID != target || !strings.Contains(rows[0].Error, "permission ceiling") {
		t.Errorf("audit failures of %s = %+v, want one naming the account", change.action, rows)
	}
}

func wantDone(t *testing.T, api *authAPI, w *httptest.ResponseRecorder, change accountChange) {
	t.Helper()
	if w.Code != change.ok {
		t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), change.ok)
	}
	if !api.db.ran(change.write) {
		t.Errorf("%q never reached the database", change.write)
	}
	if rows := api.store.failures(change.action); len(rows) != 0 {
		t.Errorf("audit failures of %s = %+v, want none", change.action, rows)
	}
}

// A new password hands the account over, so the actor must hold all it holds.
func TestPasswordResetStaysWithinWhatTheActorHolds(t *testing.T) {
	for _, c := range []struct {
		name       string
		target     string
		perms      auth.PermissionMatrix
		namespaces map[string][]string
		allowed    bool
	}{
		{"a global admin", "root", userAdmin, nil, false},
		{"a global permission the actor lacks", "auditor", userAdmin, nil, false},
		{"Admin on a cluster the actor reads", "cluster-admin", userAdmin, nil, false},
		{"a grant on a cluster the actor has no part in", "elsewhere", userAdmin, nil, false},
		{"a grant wider than the actor's namespaces", "reader", userAdmin, namespaceLimited, false},
		{"an account with nothing", "plain", userAdmin, nil, true},
		{"an account with the actor's own permissions", "peer", userAdmin, nil, true},
		{"a grant the actor holds on that cluster", "reader", userAdmin, nil, true},
		{"a grant within the actor's namespaces", "team-a-reader", userAdmin, namespaceLimited, true},
		{"cluster keys in a global role, which give nothing", "global-cluster-keys", userAdmin, nil, true},
		{"Admin on a cluster, by that cluster's admin", "cluster-admin", clusterAdmin, nil, true},
		{"a global admin, by a global admin", "root", globalAdmin, nil, true},
		{"Admin on a cluster, by a global admin", "cluster-admin", globalAdmin, nil, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			change := accountChange{"reset", http.MethodPost, "/admin/users/" + c.target + "/reset-password", "", "user.password.reset", "SET password_hash", http.StatusOK}
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
			w := api.call(api.actor(c.perms, c.namespaces), change.method, change.path, change.body)
			if !c.allowed {
				wantRefused(t, api, w, change, c.target)
				if strings.Contains(w.Body.String(), "temporary_password") {
					t.Errorf("the answer carries a password: %s", w.Body.String())
				}
				return
			}
			wantDone(t, api, w, change)
			if !strings.Contains(w.Body.String(), "temporary_password") {
				t.Errorf("no password in the answer: %s", w.Body.String())
			}
		})
	}
}

func managementChanges(id string) []accountChange {
	user := "/admin/users/" + id
	return []accountChange{
		{"delete the account", http.MethodDelete, user, "", "user.delete", "DELETE FROM auth_users", http.StatusNoContent},
		{"change the role", http.MethodPatch, user, `{"role_id":1}`, "user.role.update", "SET role_id", http.StatusOK},
		{"change the role in bulk", http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["` + id + `"]}`, "user.role.update", "SET role_id", http.StatusOK},
		{"lift a lock", http.MethodPost, user + "/unlock", "", "admin.users.unlock", "SET dormant_locked_at", http.StatusOK},
		{"set a grant", http.MethodPut, user + "/cluster-roles/c", `{"role":"Read","namespaces":["team-a"]}`, "user.cluster_role.set", "INSERT INTO user_cluster_roles", http.StatusOK},
		{"revoke a grant", http.MethodDelete, user + "/cluster-roles/c", "", "user.cluster_role.unset", "DELETE FROM user_cluster_roles", http.StatusNoContent},
	}
}

// Managing an account gains the actor nothing, and taking access away must not
// wait for someone who holds it: only what spans every cluster stays out of reach.
func TestAccountManagementStaysWithinTheActorsGlobalPermissions(t *testing.T) {
	for _, c := range []struct {
		name       string
		target     string
		perms      auth.PermissionMatrix
		namespaces map[string][]string
		allowed    bool
	}{
		{"a global admin", "root", userAdmin, nil, false},
		{"a global permission the actor lacks", "auditor", userAdmin, nil, false},
		{"a global admin, by a cluster's admin", "root", clusterAdmin, nil, false},
		{"Admin on a cluster the actor reads", "cluster-admin", userAdmin, nil, true},
		{"Admin on a cluster the actor has no part in", "elsewhere", userAdmin, nil, true},
		{"a grant wider than the actor's namespaces", "reader", userAdmin, namespaceLimited, true},
		{"an account with the actor's own permissions", "peer", userAdmin, nil, true},
		{"an account with nothing", "plain", userAdmin, nil, true},
		{"a global admin, by a global admin", "root", globalAdmin, nil, true},
	} {
		for _, change := range managementChanges(c.target) {
			t.Run(c.name+"/"+change.name, func(t *testing.T) {
				api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
				w := api.call(api.actor(c.perms, c.namespaces), change.method, change.path, change.body)
				if !c.allowed {
					wantRefused(t, api, w, change, c.target)
					return
				}
				wantDone(t, api, w, change)
			})
		}
	}
}

// A name or a team gives no power over the account.
func TestProfileChangeIsNotLimited(t *testing.T) {
	for _, target := range []string{"root", "auditor", "cluster-admin", "plain"} {
		t.Run(target, func(t *testing.T) {
			change := accountChange{"rename", http.MethodPatch, "/admin/users/" + target, `{"name":"Renamed"}`, "user.update", "SET name", http.StatusOK}
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
			wantDone(t, api, api.call(api.actor(userAdmin, nil), change.method, change.path, change.body), change)
		})
	}
}

func TestProfileChangeWithARoleIsLimited(t *testing.T) {
	change := accountChange{"rename and lower", http.MethodPatch, "/admin/users/root", `{"name":"Renamed","role_id":1}`, "user.role.update", "SET role_id", http.StatusOK}
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	wantRefused(t, api, api.call(api.actor(userAdmin, nil), change.method, change.path, change.body), change, "root")
	if api.db.ran("SET name") {
		t.Error("the profile changed in a refused call")
	}
}

// Managing is not handing out: what an account is given stays under the role ceiling.
func TestManagementHandsOutNoMoreThanTheActorHolds(t *testing.T) {
	for _, change := range []accountChange{
		{"a global role", http.MethodPatch, "/admin/users/cluster-admin", `{"role_id":10}`, "user.role.update", "SET role_id", 0},
		{"a cluster grant", http.MethodPut, "/admin/users/cluster-admin/cluster-roles/c", `{"role":"Admin"}`, "user.cluster_role.set", "INSERT INTO user_cluster_roles", 0},
	} {
		t.Run(change.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
			wantRefused(t, api, api.call(api.actor(userAdmin, nil), change.method, change.path, change.body), change, "cluster-admin")
		})
	}
}

// One's own account is always within reach, whatever an older token says.
func TestOwnPasswordResetStaysOpen(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	w := api.call(api.actor(userAdmin, nil), http.MethodPost, "/admin/users/actor/reset-password", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "temporary_password") {
		t.Fatalf("%d %s, want 200 with the temporary password", w.Code, w.Body.String())
	}
}

func TestBulkRoleChangeIsRefusedWholeForAnAccountOutOfReach(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, accountFixture()...)
	w := api.call(api.actor(userAdmin, nil), http.MethodPatch, "/admin/users/bulk-role", `{"role_id":1,"user_ids":["plain","root","auditor"]}`)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "permission ceiling") {
		t.Fatalf("%d %s, want 403 naming the permission ceiling", w.Code, w.Body.String())
	}
	if api.db.ran("SET role_id") {
		t.Error("an account's role changed in a refused call")
	}
	rows := api.store.failures("user.role.update")
	if len(rows) != 2 || rows[0].TargetID != "root" || rows[1].TargetID != "auditor" {
		t.Errorf("audit failures = %+v, want one per refused account", rows)
	}
}

// roleNameRules are the roles of an install: the built-in ones, custom ones and
// what an older build could store: a built-in's name in capitals, two names of
// one group.
func roleNameRules() []pgRule {
	row := func(id int, name string, system bool) []any { return []any{id, name, system} }
	return []pgRule{
		{match: "name, is_system FROM roles ORDER BY id", oids: []uint32{integerOID, textOID, booleanOID}, rows: [][]any{
			row(20, "Pending", true), row(roleMember, "Member", true), row(roleRead, "Read", true), row(2, "Write", true), row(roleAdmin, "Admin", true),
			row(roleCustom, "custom", false), row(roleStoredAdmin, "ADMIN", false), row(9, "sre-admin", false), row(15, "a b", false), row(16, "운영", false), row(18, "a-b", false),
		}},
		{match: "INSERT INTO roles", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{30, "new", "", false, pgNow(), pgNow()}}},
		{match: "UPDATE roles SET", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{roleCustom, "custom", "", false, pgNow(), pgNow()}}},
		roleRule(roleCustom, "custom", false),
		roleRule(roleStoredAdmin, "ADMIN", false),
		roleRule(15, "a b", false),
		roleRule(17, " read ", false),
		permsRule(roleCustom),
		permsRule(roleStoredAdmin),
		permsRule(15),
		permsRule(17),
	}
}

func TestNewRoleNameCannotShareAKubernetesGroup(t *testing.T) {
	global := auth.PermissionMatrix{"*": {"*"}}
	for _, c := range []struct {
		name   string
		want   int
		reason string
	}{
		{"ADMIN", http.StatusBadRequest, "built-in"},
		{"admin", http.StatusBadRequest, "built-in"},
		{" read ", http.StatusBadRequest, "built-in"},
		{"WRITE\t", http.StatusBadRequest, "built-in"},
		{"member", http.StatusBadRequest, "built-in"},
		{"PENDING", http.StatusBadRequest, "built-in"},
		{"ADMİN", http.StatusBadRequest, "built-in"},
		{"Read", http.StatusBadRequest, "already exists: it is a built-in role"},
		{"custom", http.StatusBadRequest, "already exists. Choose another name"},
		{"운영", http.StatusBadRequest, "already exists. Choose another name"},
		{"SRE Admin", http.StatusBadRequest, "sre-admin"},
		{"a-b", http.StatusBadRequest, "a b"},
		{"A!B", http.StatusBadRequest, "a b"},
		{" custom", http.StatusBadRequest, "custom"},
		{"개발", http.StatusBadRequest, "운영"},
		{"team-reader", http.StatusCreated, ""},
		{"Infra Manager", http.StatusCreated, ""},
		{"admin-2", http.StatusCreated, ""},
		{"운영팀", http.StatusCreated, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, roleNameRules()...)
			w := api.call(api.actor(global, nil), http.MethodPost, "/admin/roles", fmt.Sprintf(`{"name":%q,"permissions":[]}`, c.name))
			if w.Code != c.want || !strings.Contains(w.Body.String(), c.reason) {
				t.Fatalf("%d %s, want %d with %q", w.Code, w.Body.String(), c.want, c.reason)
			}
			if wrote := api.db.ran("INSERT INTO roles"); wrote != (c.want == http.StatusCreated) {
				t.Errorf("role written = %v with status %d", wrote, w.Code)
			}
			if rows := api.store.failures("admin.roles.create"); (len(rows) == 1) != (c.want == http.StatusBadRequest) {
				t.Errorf("audit failures = %+v with status %d", rows, w.Code)
			}
		})
	}
}

func TestBlankRoleNameIsRefused(t *testing.T) {
	for _, name := range []string{"", "   "} {
		api := newAuthAPI(t, pendingRequest{owner: "requester"}, roleNameRules()...)
		w := api.call(api.actor(auth.PermissionMatrix{"*": {"*"}}, nil), http.MethodPost, "/admin/roles", fmt.Sprintf(`{"name":%q,"permissions":[]}`, name))
		if w.Code != http.StatusBadRequest || api.db.ran("INSERT INTO roles") {
			t.Errorf("name %q: %d %s, want 400 and nothing written", name, w.Code, w.Body.String())
		}
	}
}

// Renames follow the same rule; a stored name stays as it is, so an install
// that already has one keeps reading and editing that role.
func TestRoleRenameCannotShareAKubernetesGroup(t *testing.T) {
	global := auth.PermissionMatrix{"*": {"*"}}
	for _, c := range []struct {
		name   string
		id     int
		rename string
		want   int
	}{
		{"to a built-in's name in capitals", roleCustom, "ADMIN", http.StatusBadRequest},
		{"to a built-in's name with spaces", roleCustom, " read ", http.StatusBadRequest},
		{"to another role's group", roleCustom, "a-b", http.StatusBadRequest},
		{"to nothing", roleCustom, "  ", http.StatusBadRequest},
		{"to a new name", roleCustom, "renamed", http.StatusOK},
		{"in capitals only", roleCustom, "CUSTOM", http.StatusOK},
		{"unchanged", roleCustom, "custom", http.StatusOK},
		{"a stored name kept as it is", roleStoredAdmin, "ADMIN", http.StatusOK},
		{"a stored name to another built-in variant", roleStoredAdmin, "admin", http.StatusBadRequest},
		{"a stored name to a free one", roleStoredAdmin, "site-admin", http.StatusOK},
		{"a stored colliding name kept as it is", 15, "a b", http.StatusOK},
		{"a stored colliding name to another form of it", 15, "A B", http.StatusBadRequest},
		{"a stored colliding name to a free one", 15, "a c", http.StatusOK},
		{"a stored name with spaces, trimmed as the screen sends it", 17, "read", http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, roleNameRules()...)
			w := api.call(api.actor(global, nil), http.MethodPut, fmt.Sprintf("/admin/roles/%d", c.id), fmt.Sprintf(`{"name":%q,"permissions":[]}`, c.rename))
			if w.Code != c.want {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
			if wrote := api.db.ran("UPDATE roles SET"); wrote != (c.want == http.StatusOK) {
				t.Errorf("role written = %v with status %d", wrote, w.Code)
			}
		})
	}
}

// grantedOn makes the database say on which clusters the role is granted; a nil
// namespaces is the whole cluster.
func grantedOn(roleID int, rows ...[]any) pgRule {
	return pgRule{match: fmt.Sprintf("FROM user_cluster_roles WHERE role_id =  '%d' ", roleID), oids: []uint32{textOID, listOID}, rows: rows}
}

func TestRoleEditStaysWithinWhatTheEditorHoldsWhereItIsGranted(t *testing.T) {
	devAdmin := auth.PermissionMatrix{"*": {roleUpdatePerm}, "dev": {"*"}, "prod": {"menu.dashboard", "menu.*", "resource.*.read"}}
	teamAdmin := auth.PermissionMatrix{"*": {roleUpdatePerm}, "prod": {"*"}}
	teamScope := map[string][]string{"prod": {"team-a"}}
	global := auth.PermissionMatrix{"*": {"*"}}
	for _, c := range []struct {
		name       string
		held       []string
		perms      []string
		grants     [][]any
		actor      auth.PermissionMatrix
		namespaces map[string][]string
		allowed    bool
	}{
		{"a key the editor lacks where the role is granted", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"prod", nil}}, devAdmin, nil, false},
		{"a key the editor lacks on one of the clusters", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"dev", nil}, {"prod", nil}}, devAdmin, nil, false},
		{"a key beyond the editor's namespaces there", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"prod", nil}}, teamAdmin, teamScope, false},
		{"a key the editor holds where the role is granted", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"dev", nil}}, devAdmin, nil, true},
		{"a key on a role granted nowhere", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, nil, devAdmin, nil, true},
		{"a key within the editor's namespaces there", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"prod", "{team-a}"}}, teamAdmin, teamScope, true},
		{"a key from a global admin", []string{"menu.dashboard"}, []string{"menu.dashboard", widerClusterKey}, [][]any{{"prod", nil}}, global, nil, true},
		{"taking a key away", []string{"menu.dashboard", widerClusterKey}, []string{"menu.dashboard"}, [][]any{{"prod", nil}}, devAdmin, nil, true},
		{"narrowing a wildcard", []string{"menu.*"}, []string{"menu.dashboard"}, [][]any{{"prod", nil}}, devAdmin, nil, true},
		{"the description alone", []string{"menu.dashboard"}, []string{"menu.dashboard"}, [][]any{{"prod", nil}}, devAdmin, nil, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			rules := append(roleNameRules(), grantedOn(roleCustom, c.grants...))
			rules = append([]pgRule{permsRule(roleCustom, c.held...)}, rules...)
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, rules...)
			body := fmt.Sprintf(`{"name":"custom","description":"edited","permissions":["%s"]}`, strings.Join(c.perms, `","`))
			w := api.call(api.actor(c.actor, c.namespaces), http.MethodPut, fmt.Sprintf("/admin/roles/%d", roleCustom), body)
			if !c.allowed {
				if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "permission ceiling") {
					t.Fatalf("%d %s, want 403 naming the permission ceiling", w.Code, w.Body.String())
				}
				if api.db.ran("UPDATE roles SET") {
					t.Error("the role changed")
				}
				if rows := api.store.failures("admin.roles.update"); len(rows) != 1 || !strings.Contains(rows[0].Error, "permission ceiling") {
					t.Errorf("audit failures = %+v, want one naming the ceiling", rows)
				}
				return
			}
			if w.Code != http.StatusOK {
				t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
			}
			if !api.db.ran("UPDATE roles SET") {
				t.Error("the role never reached the database")
			}
		})
	}
}

// A role's creation is not tied to any grant yet: the old rule still holds.
func TestNewRoleStaysWithinWhatTheCreatorHoldsSomewhere(t *testing.T) {
	devAdmin := auth.PermissionMatrix{"*": {roleCreatePerm}, "dev": {"*"}}
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, roleNameRules()...)
	w := api.call(api.actor(devAdmin, nil), http.MethodPost, "/admin/roles", fmt.Sprintf(`{"name":"new","permissions":[%q]}`, widerClusterKey))
	if w.Code != http.StatusCreated {
		t.Fatalf("%d %s, want 201", w.Code, w.Body.String())
	}
}
