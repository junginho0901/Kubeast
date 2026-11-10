package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const roleChartBound = 19

var (
	roleAdminOnly    = auth.PermissionMatrix{"*": {roleCreatePerm, roleUpdatePerm}}
	allAdminKeys     = auth.PermissionMatrix{"*": {"admin.*"}}
	adminOfACluster  = auth.PermissionMatrix{"*": {roleCreatePerm, roleUpdatePerm}, "c": {"*"}}
	chartBindsOpsSRE = func(c *config.Config) { c.ImpersonationCustomRoles = []string{"sre-readonly", "ops", "read"} }
)

// chartRoleRules are an install's roles: the built-in ones, a custom one and
// "ops", a role the chart binds. The chart's "sre-readonly" has no role yet, as
// when it was just listed or its role was deleted.
func chartRoleRules() []pgRule {
	row := func(id int, name string, system bool) []any { return []any{id, name, system} }
	return []pgRule{
		{match: "name, is_system FROM roles ORDER BY id", oids: []uint32{integerOID, textOID, booleanOID}, rows: [][]any{
			row(roleMember, "Member", true), row(roleRead, "Read", true), row(2, "Write", true), row(roleAdmin, "Admin", true),
			row(roleCustom, "plain", false), row(roleChartBound, "ops", false),
		}},
		{match: "INSERT INTO roles", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{30, "new", "", false, pgNow(), pgNow()}}},
		{match: "UPDATE roles SET", oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{{roleCustom, "plain", "", false, pgNow(), pgNow()}}},
		roleRule(roleCustom, "plain", false),
		roleRule(roleChartBound, "ops", false),
		permsRule(roleCustom),
		permsRule(roleChartBound),
	}
}

func wantCeilingRow(t *testing.T, api *authAPI, action string) {
	t.Helper()
	rows := api.store.failures(action)
	if len(rows) != 1 || !strings.Contains(rows[0].Error, "permission ceiling") {
		t.Errorf("audit failures of %s = %+v, want one naming the ceiling", action, rows)
	}
}

// A group the chart binds holds its ClusterRoles before a role of that name
// exists, so the name is for those who hold whatever a cluster can give.
func TestNewRoleNameTheChartBindsIsForAGlobalAdmin(t *testing.T) {
	for _, c := range []struct {
		name   string
		actor  auth.PermissionMatrix
		role   string
		want   int
		reason string
	}{
		{"a role admin, the name as listed", roleAdminOnly, "sre-readonly", http.StatusForbidden, "kubeast:role:sre-readonly"},
		{"a role admin, in capitals", roleAdminOnly, "SRE-Readonly", http.StatusForbidden, "kubeast:role:sre-readonly"},
		{"a role admin, with spaces for the same group", roleAdminOnly, " sre readonly ", http.StatusForbidden, "kubeast:role:sre-readonly"},
		{"every admin key without all permissions", allAdminKeys, "sre-readonly", http.StatusForbidden, "kubeast:role:sre-readonly"},
		{"Admin on one cluster", adminOfACluster, "sre-readonly", http.StatusForbidden, "kubeast:role:sre-readonly"},
		{"a global admin, the name as listed", globalAdmin, "sre-readonly", http.StatusCreated, ""},
		{"a global admin, in capitals", globalAdmin, "SRE Readonly", http.StatusCreated, ""},
		{"a role admin, a name the chart does not list", roleAdminOnly, "team-reader", http.StatusCreated, ""},
		{"a global admin, a built-in the chart lists for namespaces", globalAdmin, "READ", http.StatusBadRequest, "built-in"},
		{"a role admin, a built-in the chart lists for namespaces", roleAdminOnly, "READ", http.StatusBadRequest, "built-in"},
		{"a global admin, a role that exists", globalAdmin, "OPS", http.StatusBadRequest, "ops"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, chartBindsOpsSRE, chartRoleRules()...)
			w := api.call(api.actor(c.actor, nil), http.MethodPost, "/admin/roles", fmt.Sprintf(`{"name":%q,"permissions":[]}`, c.role))
			if w.Code != c.want || !strings.Contains(w.Body.String(), c.reason) {
				t.Fatalf("%d %s, want %d with %q", w.Code, w.Body.String(), c.want, c.reason)
			}
			if wrote := api.db.ran("INSERT INTO roles"); wrote != (c.want == http.StatusCreated) {
				t.Errorf("role written = %v with status %d", wrote, w.Code)
			}
			if c.want == http.StatusForbidden {
				wantCeilingRow(t, api, "admin.roles.create")
			}
		})
	}
}

// An install without such a list keeps today's rule, and one that sets the list
// by hand may write role names rather than their slugs.
func TestChartListDecidesWhichNamesAreHeldBack(t *testing.T) {
	for _, c := range []struct {
		name  string
		chart []string
		want  int
	}{
		{"no list", nil, http.StatusCreated},
		{"another name on the list", []string{"other"}, http.StatusCreated},
		{"the slug on the list", []string{"sre-readonly"}, http.StatusForbidden},
		{"the role's name on the list", []string{"SRE Readonly"}, http.StatusForbidden},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, func(cfg *config.Config) { cfg.ImpersonationCustomRoles = c.chart }, chartRoleRules()...)
			w := api.call(api.actor(roleAdminOnly, nil), http.MethodPost, "/admin/roles", `{"name":"sre-readonly","permissions":[]}`)
			if w.Code != c.want {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
		})
	}
}

// A rename takes a new group the same way a new role does. A role the chart
// already binds stays open to its editors: its holders' group does not change.
func TestRoleRenameIntoANameTheChartBindsIsForAGlobalAdmin(t *testing.T) {
	for _, c := range []struct {
		name   string
		actor  auth.PermissionMatrix
		id     int
		rename string
		want   int
	}{
		{"a role admin, onto a listed name", roleAdminOnly, roleCustom, "sre-readonly", http.StatusForbidden},
		{"a role admin, onto a listed name in capitals", roleAdminOnly, roleCustom, "SRE READONLY", http.StatusForbidden},
		{"every admin key without all permissions", allAdminKeys, roleCustom, "sre-readonly", http.StatusForbidden},
		{"a global admin, onto a listed name", globalAdmin, roleCustom, "sre-readonly", http.StatusOK},
		{"a role admin, a free name", roleAdminOnly, roleCustom, "renamed", http.StatusOK},
		{"a role admin, onto a listed name another role has", roleAdminOnly, roleCustom, "OPS", http.StatusBadRequest},
		{"a role admin edits the listed role", roleAdminOnly, roleChartBound, "ops", http.StatusOK},
		{"a role admin, the listed role in capitals", roleAdminOnly, roleChartBound, "OPS", http.StatusOK},
		{"a role admin, the listed role away to a free name", roleAdminOnly, roleChartBound, "ops-2", http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, chartBindsOpsSRE, chartRoleRules()...)
			w := api.call(api.actor(c.actor, nil), http.MethodPut, fmt.Sprintf("/admin/roles/%d", c.id), fmt.Sprintf(`{"name":%q,"permissions":[]}`, c.rename))
			if w.Code != c.want {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
			if wrote := api.db.ran("UPDATE roles SET"); wrote != (c.want == http.StatusOK) {
				t.Errorf("role written = %v with status %d", wrote, w.Code)
			}
			if c.want == http.StatusForbidden {
				wantCeilingRow(t, api, "admin.roles.update")
			}
		})
	}
}

// The role list names the custom roles the chart binds, whose grant the screens offer only to who may give it; the
// built-in names the chart binds for grants limited to namespaces are not among them.
func TestTheRoleListNamesTheRolesTheChartBinds(t *testing.T) {
	row := func(id int, name string, system bool) []any { return []any{id, name, "", system, pgNow(), pgNow()} }
	api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, chartBindsOpsSRE,
		pgRule{match: "description, is_system, created_at, updated_at FROM roles ORDER BY id",
			oids: []uint32{integerOID, textOID, textOID, booleanOID, stampOID, stampOID},
			rows: [][]any{row(roleRead, "Read", true), row(roleCustom, "plain", false), row(roleChartBound, "ops", false)}})
	w := api.call(api.actor(auth.PermissionMatrix{"c": {readPerm}}, nil), http.MethodGet, "/roles", "")
	var roles []struct {
		Name       string `json:"name"`
		ChartBound bool   `json:"chart_bound"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &roles); err != nil || w.Code != http.StatusOK {
		t.Fatalf("%d %s: %v", w.Code, w.Body.String(), err)
	}
	got := map[string]bool{}
	for _, r := range roles {
		got[r.Name] = r.ChartBound
	}
	if want := map[string]bool{"Read": false, "plain": false, "ops": true}; !maps.Equal(got, want) {
		t.Fatalf("chart_bound %v, want %v", got, want)
	}
}
