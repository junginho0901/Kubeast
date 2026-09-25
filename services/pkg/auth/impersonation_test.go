package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

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

func TestKubectlImpersonationArgs(t *testing.T) {
	p := TokenPayload{Email: "a@example.com", Roles: map[string]string{"test2": "Read"}}
	got := KubectlImpersonationArgs(p, "test2")
	want := []string{"--as", "a@example.com", "--as-group", GroupAuthenticated, "--as-group", GroupViewer}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
}
