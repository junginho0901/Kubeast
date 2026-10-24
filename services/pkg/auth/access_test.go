package auth

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"testing"
)

func TestAccess(t *testing.T) {
	cases := []struct {
		name    string
		payload TokenPayload
		imp     bool
		want    Access
	}{
		{"read role", TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Read"}}, true,
			Access{Cluster: "prod", Kind: "person", User: "a@example.com", Groups: []string{GroupAuthenticated, GroupViewer}, Role: "Read", Impersonation: true}},
		{"namespace-limited grant", TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Write"}, Namespaces: map[string][]string{"prod": {"shop", "payments"}}}, true,
			Access{Cluster: "prod", Kind: "person", User: "a@example.com", Groups: []string{GroupAuthenticated, "kubeast:role:write"}, Role: "Write", Namespaces: []string{"shop", "payments"}, Impersonation: true}},
		{"global admin without a cluster role", TokenPayload{Email: "root@example.com", Perms: PermissionMatrix{"*": {"*"}}}, true,
			Access{Cluster: "prod", Kind: "person", User: "root@example.com", Groups: []string{GroupAdmin, GroupAuthenticated}, Role: "*", Impersonation: true}},
		{"api key", TokenPayload{Email: "a@example.com", APIKeyID: "k-1", Roles: map[string]string{"prod": "Read"}}, true,
			Access{Cluster: "prod", Kind: "api_key", APIKey: "k-1", User: "a@example.com", Groups: []string{GroupAuthenticated, GroupViewer}, Role: "Read", Impersonation: true}},
		{"investigator: no role, its own identity", TokenPayload{Email: UserInvestigator, System: SystemInvestigator, Roles: map[string]string{"prod": "Admin"}}, true,
			Access{Cluster: "prod", Kind: "investigator", User: UserInvestigator, Groups: []string{GroupInvestigator}, Impersonation: true}},
		{"impersonation off: nothing sent", TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "Read"}}, false,
			Access{Cluster: "prod", Kind: "person", Role: "Read"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.payload.Access("prod", c.imp)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("Access = %+v, want %+v", got, c.want)
			}
			if c.imp {
				user, groups := c.payload.Impersonation("prod")
				if got.User != user || !reflect.DeepEqual(got.Groups, groups) {
					t.Fatalf("Access shows %s %v, Impersonation sends %s %v", got.User, got.Groups, user, groups)
				}
			}
		})
	}
}

func TestAccessHeader_RoundTrip(t *testing.T) {
	a := TokenPayload{Email: "a@example.com", Roles: map[string]string{"prod": "운영 당번"}}.Access("prod", true)
	raw, err := base64.RawURLEncoding.DecodeString(a.Header())
	if err != nil {
		t.Fatalf("header is not base64url: %v", err)
	}
	var back Access
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, a) {
		t.Fatalf("round trip = %+v, want %+v", back, a)
	}
	for _, r := range a.Header() {
		if r > 0x7e {
			t.Fatalf("header has a non-ASCII byte: %q", a.Header())
		}
	}
}
