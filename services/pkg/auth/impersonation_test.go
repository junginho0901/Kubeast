package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
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

	// Without a user and unmarked: refused, nothing sent.
	base.req = nil
	body := &closeRecorder{}
	plain := httptest.NewRequest("POST", "https://k8s/api/v1/namespaces/default/configmaps", body)
	if _, err := rt.RoundTrip(plain); !errors.Is(err, ErrNoPerson) {
		t.Fatalf("no user, no mark: err = %v, want ErrNoPerson", err)
	}
	if base.req != nil {
		t.Fatal("no user, no mark: the request must not reach the cluster")
	}
	if !body.closed {
		t.Fatal("a refused request's body must be closed")
	}

	// Kubeast's own call: sent under the service credential, no Impersonate-* headers.
	own := httptest.NewRequest("GET", "https://k8s/version", nil).WithContext(AsKubeast(context.Background()))
	if _, err := rt.RoundTrip(own); err != nil {
		t.Fatal(err)
	}
	if base.req == nil {
		t.Fatal("a call marked AsKubeast must be sent")
	}
	if base.req.Header.Get(HeaderImpersonateUser) != "" || len(base.req.Header.Values(HeaderImpersonateGroup)) != 0 {
		t.Fatal("a call marked AsKubeast must carry no Impersonate-* headers")
	}

	// The mark does not stand for the person a context carries.
	base.req = nil
	both := httptest.NewRequest("GET", "https://k8s/api", nil).WithContext(AsKubeast(WithPayload(context.Background(), p)))
	if _, err := rt.RoundTrip(both); err != nil {
		t.Fatal(err)
	}
	if got := base.req.Header.Get(HeaderImpersonateUser); got != "a@example.com" {
		t.Fatalf("person and mark: Impersonate-User = %q, want the person", got)
	}

	// A pinned person stands for a context that names none, and only then.
	base.req = nil
	pinned := httptest.NewRequest("GET", "https://k8s/api", nil).WithContext(WithPinnedPerson(context.Background(), p))
	if _, err := rt.RoundTrip(pinned); err != nil {
		t.Fatal(err)
	}
	if got := base.req.Header.Get(HeaderImpersonateUser); got != "a@example.com" {
		t.Fatalf("pinned: Impersonate-User = %q, want the pinned person", got)
	}
	if _, ok := FromContext(pinned.Context()); ok {
		t.Fatal("FromContext must not read a pinned person")
	}
	other := TokenPayload{Email: "b@example.com"}
	mixed := httptest.NewRequest("GET", "https://k8s/api", nil).WithContext(WithPinnedPerson(WithPayload(context.Background(), other), p))
	if _, err := rt.RoundTrip(mixed); err != nil {
		t.Fatal(err)
	}
	if got := base.req.Header.Get(HeaderImpersonateUser); got != "b@example.com" {
		t.Fatalf("person and pinned: Impersonate-User = %q, want the context's person", got)
	}
}

// A request marked as Kubeast's own and naming no person goes out only as a GET of a path client-go's discovery client
// asks (/version, /api, /apis, /api/v1, /apis/<group>/<version>) under the server URL's path; any other is refused as
// one naming no person is, with the same log line. A person in its context is never held to that.
func TestKubeastOwnRequestsAreVersionAndDiscoveryReadsOnly(t *testing.T) {
	var logs bytes.Buffer
	was := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(was) })
	const rancher = "/k8s/clusters/c-1"
	for _, c := range []struct {
		method, serverPath, path string
		sent                     bool
	}{
		// the server version (/health, the health probe, the version a screen shows) and the discovery reads
		// (ServerGroupsAndResources, ServerGroups, ServerResourcesForGroupVersion) as client-go writes them
		{"GET", "", "/version", true},
		{"GET", "", "/api", true},
		{"GET", "", "/apis", true},
		{"GET", "", "/api/v1", true},
		{"GET", "", "/apis/apps/v1", true},
		{"GET", "", "/apis/scheduling.k8s.io/v1alpha2", true},
		{"GET", "/", "/version", true},
		{"GET", rancher, rancher + "/version", true},
		{"GET", rancher, rancher + "/api", true},
		{"GET", rancher + "/", rancher + "/apis", true},
		{"GET", rancher, rancher + "/api/v1", true},
		{"GET", rancher, rancher + "/apis/metrics.k8s.io/v1beta1", true},
		{"GET", "k8s//clusters/c-1/", rancher + "/apis/apps/v1", true},

		{"GET", "", "/api/v1/namespaces/shop/configmaps/app", false},
		{"GET", "", "/api/v1/namespaces/shop/secrets", false},
		{"GET", "", "/api/v1/pods", false},
		{"GET", "", "/api/v1/nodes?watch=true", false},
		{"GET", "", "/api/v1/namespaces", false},
		{"GET", "", "/apis/apps/v1/deployments", false},
		{"GET", "", "/apis/apps/v1/namespaces/shop/deployments/web", false},
		{"GET", "", "/apis/apps/v1/namespaces/shop/deployments?watch=true", false},
		{"GET", "", "/api/v1/namespaces/shop/services/web:80/proxy/version", false},
		{"GET", "", "/api/v1/namespaces/shop/pods/web-0/proxy/apis/apps/v1", false},
		{"GET", "", "/apis/apps", false},
		{"GET", "", "/apis/apps/v1/", false},
		{"GET", "", "/apis//v1", false},
		{"GET", "", "/apis/apps/..", false},
		{"GET", "", "/api/v2", false},
		{"GET", "", "/openapi/v2", false},
		{"GET", "", "/", false},
		{"POST", "", "/api/v1/namespaces/shop/configmaps", false},
		{"PUT", "", "/api/v1/namespaces/shop/configmaps/app", false},
		{"PATCH", "", "/apis/apps/v1/namespaces/shop/deployments/web", false},
		{"DELETE", "", "/api/v1/namespaces/shop/pods/web-0", false},
		{"POST", "", "/version", false},
		{"POST", "", "/apis/apps/v1", false},
		{"DELETE", "", "/api", false},
		{"HEAD", "", "/version", false},
		{"GET", rancher, "/version", false},
		{"GET", rancher, "/k8s/clusters/c-10/version", false},
		{"GET", rancher, "/k8s/clusters/c-2/apis/apps/v1", false},
		{"GET", rancher, rancher + "/api/v1/namespaces/shop/services/web:80/proxy/version", false},
		{"GET", rancher, "/api/v1/namespaces/shop/services/web:80/proxy" + rancher + "/version", false},
		{"GET", rancher, rancher + "/apis/apps/v1/namespaces/shop/deployments", false},
		{"GET", rancher, rancher, false},
	} {
		name := c.method + " " + c.path + " under " + strconv.Quote(c.serverPath)
		base := &captureRT{}
		rt := ImpersonationRoundTripperAt(base, "prod", c.serverPath)
		body := &closeRecorder{}
		req := httptest.NewRequest(c.method, "https://k8s"+c.path, body).WithContext(AsKubeast(context.Background()))
		logs.Reset()
		_, err := rt.RoundTrip(req)
		if c.sent {
			if err != nil || base.req == nil {
				t.Errorf("%s: err %v, sent %v; want sent as Kubeast itself", name, err, base.req != nil)
				continue
			}
			if base.req.Header.Get(HeaderImpersonateUser) != "" || len(base.req.Header.Values(HeaderImpersonateGroup)) != 0 {
				t.Errorf("%s: sent with Impersonate-* headers", name)
			}
			continue
		}
		if !errors.Is(err, ErrNoPerson) || base.req != nil {
			t.Errorf("%s: err %v, sent %v; want ErrNoPerson and nothing sent", name, err, base.req != nil)
			continue
		}
		if !body.closed {
			t.Errorf("%s: the refused request's body was not closed", name)
		}
		want := fmt.Sprintf("msg=\"cluster request with no person refused\" cluster=prod method=%s path=%s\n", c.method, req.URL.Path)
		if line := logs.String(); !strings.HasSuffix(line, want) || strings.Count(line, "\n") != 1 {
			t.Errorf("%s: log %q, want one line ending %q", name, line, want)
		}
	}

	// the person in the context goes on deciding: a read or a write of an object, marked or not, goes as the person
	p := TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Read"}}
	for _, method := range []string{"GET", "DELETE"} {
		base := &captureRT{}
		req := httptest.NewRequest(method, "https://k8s"+rancher+"/api/v1/namespaces/shop/configmaps/app", nil).WithContext(AsKubeast(WithPayload(context.Background(), p)))
		if _, err := ImpersonationRoundTripperAt(base, "prod", rancher).RoundTrip(req); err != nil || base.req == nil || base.req.Header.Get(HeaderImpersonateUser) != "a@example.com" {
			t.Errorf("%s of an object by a person, marked: err %v, sent %v", method, err, base.req != nil)
		}
	}
}

type closeRecorder struct{ closed bool }

func (c *closeRecorder) Read([]byte) (int, error) { return 0, io.EOF }
func (c *closeRecorder) Close() error             { c.closed = true; return nil }

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
