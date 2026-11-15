package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

// roleGroupSlugCasesFile is the one table of the group a role name makes, also run by the database's role_group_slug
// (services/pkg/dbmigrate role_names_postgres_test.go) and the frontend's roleGroupSlug (roleGroup.test.ts).
const roleGroupSlugCasesFile = "../../../frontend/src/utils/roleGroupSlug.cases.json"

func TestRoleGroupSlugCases(t *testing.T) {
	raw, err := os.ReadFile(roleGroupSlugCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct{ Name, Slug string }
	}
	if err := json.Unmarshal(raw, &file); err != nil || len(file.Cases) == 0 {
		t.Fatalf("%s: %v (%d cases)", roleGroupSlugCasesFile, err, len(file.Cases))
	}
	for _, c := range file.Cases {
		if got := RoleGroupSlug(c.Name); got != c.Slug {
			t.Errorf("RoleGroupSlug(%q) = %q, want %q", c.Name, got, c.Slug)
		}
	}
}

func TestImpersonation_Groups(t *testing.T) {
	cases := []struct {
		name    string
		payload TokenPayload
		cluster string
		user    string
		groups  []string
	}{
		{"read role → viewer", TokenPayload{UserID: "u1", Email: "a@example.com", Roles: map[string]string{"prod": "Read"}}, "prod",
			"a@example.com", []string{GroupAuthenticated, GroupViewer}},
		{"write role → operator", TokenPayload{Email: "a@example.com", Roles: map[string]string{"alpha": "Write"}}, "alpha",
			"a@example.com", []string{GroupAuthenticated, GroupOperator}},
		{"admin role → admin", TokenPayload{Email: "a@example.com", Roles: map[string]string{"alpha": "Admin"}}, "alpha",
			"a@example.com", []string{GroupAdmin, GroupAuthenticated}},
		{"global superuser without a cluster role → admin", TokenPayload{Email: "root@example.com", Perms: PermissionMatrix{"*": {"*"}}}, "prod",
			"root@example.com", []string{GroupAdmin, GroupAuthenticated}},
		{"no grant in this cluster → authenticated only", TokenPayload{Email: "a@example.com", Roles: map[string]string{"alpha": "Write"}}, "prod",
			"a@example.com", []string{GroupAuthenticated}},
		{"custom role → kubeast:role:<slug>", TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "SRE On Call"}}, "prod",
			"a@example.com", []string{GroupAuthenticated, "kubeast:role:sre-on-call"}},
		{"no email falls back to user id", TokenPayload{UserID: "uid-9", Roles: map[string]string{"prod": "Read"}}, "prod",
			"uid-9", []string{GroupAuthenticated, GroupViewer}},
		{"investigator → its own user and group only, whatever else the token carries",
			TokenPayload{UserID: "system", Email: UserInvestigator, System: SystemInvestigator, Roles: map[string]string{"prod": "Admin"}, Perms: PermissionMatrix{"*": {"*"}}}, "prod",
			UserInvestigator, []string{GroupInvestigator}},
		{"unknown system principal → authenticated only",
			TokenPayload{UserID: "system", Email: "kubeast:other", System: "other", Roles: map[string]string{"prod": "Read"}}, "prod",
			"kubeast:other", []string{GroupAuthenticated}},
	}
	for _, c := range cases {
		user, groups := c.payload.Impersonation(c.cluster)
		if user != c.user || !reflect.DeepEqual(groups, c.groups) {
			t.Fatalf("%s: got (%q, %v), want (%q, %v)", c.name, user, groups, c.user, c.groups)
		}
	}
}

type captureRT struct{ req *http.Request }

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	c.req = r
	return &http.Response{StatusCode: 200, Body: http.NoBody, Request: r}, nil
}

func TestImpersonationRoundTripper(t *testing.T) {
	base := &captureRT{}
	rt := ImpersonationRoundTripper(base, "prod")

	// With a user in ctx: headers carry the identity.
	p := TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Write"}}
	req := httptest.NewRequest("GET", "https://k8s/api/v1/pods", nil).WithContext(WithPayload(context.Background(), p))
	req.Header.Set(HeaderImpersonateGroup, "system:masters") // must not survive
	if _, err := rt.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if got := base.req.Header.Get(HeaderImpersonateUser); got != "a@example.com" {
		t.Fatalf("Impersonate-User = %q", got)
	}
	if got := base.req.Header.Values(HeaderImpersonateGroup); !reflect.DeepEqual(got, []string{GroupAuthenticated, GroupOperator}) {
		t.Fatalf("Impersonate-Group = %v", got)
	}
	if req.Header.Get(HeaderImpersonateUser) != "" {
		t.Fatal("the caller's request must not be mutated")
	}

	// Without a user: no impersonation headers (service identity).
	base.req = nil
	plain := httptest.NewRequest("GET", "https://k8s/healthz", nil)
	if _, err := rt.RoundTrip(plain); err != nil {
		t.Fatal(err)
	}
	if base.req.Header.Get(HeaderImpersonateUser) != "" || len(base.req.Header.Values(HeaderImpersonateGroup)) != 0 {
		t.Fatal("no user in ctx must mean no impersonation headers")
	}
}

// A check asked by groups goes out as its name with the person's groups exactly, and is not sent without them.
func TestAGroupCheckGoesOutAsItsNameWithThePersonsGroupsOrNotAtAll(t *testing.T) {
	base := &captureRT{}
	rt := ImpersonationRoundTripper(base, "prod")
	p := TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Read"}}
	_, groups := p.Impersonation("prod")
	name := GroupCheckUserPrefix + "0a1b2c3d"
	send := func(ctx context.Context) error {
		base.req = nil
		_, err := rt.RoundTrip(httptest.NewRequest("POST", "https://k8s/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", nil).WithContext(ctx))
		return err
	}
	if err := send(AsGroupCheck(WithPayload(context.Background(), p), name, groups)); err != nil {
		t.Fatal(err)
	}
	if got := base.req.Header.Get(HeaderImpersonateUser); got != name {
		t.Errorf("Impersonate-User = %q, want %q", got, name)
	}
	if got := base.req.Header.Values(HeaderImpersonateGroup); !reflect.DeepEqual(got, groups) {
		t.Errorf("Impersonate-Group = %v, want the person's %v", got, groups)
	}
	for _, c := range []struct {
		name string
		ctx  context.Context
	}{
		{"no person", AsGroupCheck(context.Background(), name, groups)},
		{"other groups", AsGroupCheck(WithPayload(context.Background(), p), name, []string{GroupAuthenticated, GroupAdmin})},
		{"no groups", AsGroupCheck(WithPayload(context.Background(), p), name, nil)},
		{"no name", AsGroupCheck(WithPayload(context.Background(), p), "", groups)},
		{"the person's own name", AsGroupCheck(WithPayload(context.Background(), p), "a@example.com", groups)},
	} {
		if err := send(c.ctx); err == nil || base.req != nil {
			t.Errorf("%s: sent %v, err %v; want nothing sent", c.name, base.req != nil, err)
		}
	}
}

func TestKubectlImpersonationArgs(t *testing.T) {
	p := TokenPayload{Email: "a@example.com", Roles: map[string]string{"test2": "Read"}}
	got := KubectlImpersonationArgs(p, "test2")
	want := []string{"--as", "a@example.com", "--as-group", GroupAuthenticated, "--as-group", GroupViewer}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
}

// A built-in role is known by its exact seeded name. A custom role whose name makes a built-in's slug (stored before
// such names were refused) acts as no role group, cluster-wide or limited to namespaces: never as the built-in's group
// nor as the kubeast:role:<slug> the chart binds for the built-ins' grants limited to namespaces.
func TestImpersonation_RoleNamesOfTheBuiltInsInOtherForms(t *testing.T) {
	const cluster = "prod"
	for _, c := range []struct {
		role      string
		wide, ns  []string
		isBuiltin bool
		takesSlug bool
	}{
		{"Admin", []string{GroupAdmin, GroupAuthenticated}, []string{GroupAuthenticated, "kubeast:role:admin"}, true, false},
		{"Write", []string{GroupAuthenticated, GroupOperator}, []string{GroupAuthenticated, "kubeast:role:write"}, true, false},
		{"Read", []string{GroupAuthenticated, GroupViewer}, []string{GroupAuthenticated, "kubeast:role:read"}, true, false},
		{"Member", []string{GroupAuthenticated, "kubeast:role:member"}, []string{GroupAuthenticated, "kubeast:role:member"}, true, false},
		{"ADMIN", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{"admin", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{" Admin ", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{"WRITE", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{"write", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{" read ", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{"PENDING", []string{GroupAuthenticated}, []string{GroupAuthenticated}, false, true},
		{"sre-oncall", []string{GroupAuthenticated, "kubeast:role:sre-oncall"}, []string{GroupAuthenticated, "kubeast:role:sre-oncall"}, false, false},
		{"admin-2", []string{GroupAuthenticated, "kubeast:role:admin-2"}, []string{GroupAuthenticated, "kubeast:role:admin-2"}, false, false},
	} {
		if IsBuiltinRole(c.role) != c.isBuiltin || TakesBuiltinSlug(c.role) != c.takesSlug {
			t.Errorf("%q: IsBuiltinRole %v, TakesBuiltinSlug %v; want %v, %v", c.role, IsBuiltinRole(c.role), TakesBuiltinSlug(c.role), c.isBuiltin, c.takesSlug)
		}
		for _, scope := range []struct {
			name       string
			namespaces map[string][]string
			want       []string
		}{
			{"cluster-wide", nil, c.wide},
			{"limited to namespaces", map[string][]string{cluster: {"shop"}}, c.ns},
		} {
			p := TokenPayload{Email: "a@example.com", Roles: map[string]string{cluster: c.role}, Namespaces: scope.namespaces}
			if _, groups := p.Impersonation(cluster); !reflect.DeepEqual(groups, scope.want) {
				t.Errorf("%q %s: groups %v, want %v", c.role, scope.name, groups, scope.want)
			}
			// the 🔐 line shows the same identity, the role as stored and whether it gives no role group
			if a := p.Access(cluster, true); !reflect.DeepEqual(a.Groups, scope.want) || a.Role != c.role || a.NoRoleGroup != c.takesSlug {
				t.Errorf("%q %s: Access %+v, want groups %v", c.role, scope.name, a, scope.want)
			}
		}
	}
}
