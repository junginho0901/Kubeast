package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var (
	readPerms  = []string{"k8s.pods.read", "k8s.deployments.read", "helm.releases.read"}
	writePerms = []string{"k8s.pods.read", "k8s.pods.delete", "k8s.deployments.read", "k8s.deployments.update", "helm.releases.read", "helm.releases.upgrade"}
)

func TestRoleAtMost(t *testing.T) {
	cases := []struct{ role, ceiling, want string }{
		{"Read", "Write", "Read"},
		{"Write", "Write", "Write"},
		{"Admin", "Write", "Write"},
		{"Admin", "Read", "Read"},
		{"Write", "Admin", "Write"},
		{"Read", "Admin", "Read"},
		{"auditor", "Write", "auditor"}, // custom role: unranked, keeps its own name
		{"auditor", "Admin", "auditor"},
		{"", "Read", ""},
	}
	for _, c := range cases {
		if got := roleAtMost(c.role, c.ceiling); got != c.want {
			t.Errorf("roleAtMost(%q, %q) = %q, want %q", c.role, c.ceiling, got, c.want)
		}
	}
}

func TestIntersectPerms(t *testing.T) {
	cases := []struct {
		name string
		a, b []string
		want []string
	}{
		{"write capped at read", writePerms, readPerms, []string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}},
		{"read under write ceiling stays read", readPerms, writePerms, []string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}},
		{"superuser wildcard yields the ceiling", []string{"*"}, readPerms, []string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}},
		{"wildcard pattern narrows to the matching entries", []string{"k8s.pods.*"}, readPerms, []string{"k8s.pods.read"}},
		{"wildcard on both sides survives", []string{"*"}, []string{"*"}, []string{"*"}},
		{"disjoint", []string{"admin.users.read"}, readPerms, nil},
	}
	for _, c := range cases {
		if got := intersectPerms(c.a, c.b); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: intersectPerms = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNarrowForAPIKey(t *testing.T) {
	// A user who is Write on test2 and Read on default; nothing global.
	matrix := auth.PermissionMatrix{"test2": writePerms, "default": readPerms}
	roles := map[string]string{"test2": "Write", "default": "Read"}

	m, r := narrowForAPIKey(matrix, roles, []string{"test2"}, "Read", readPerms)
	if _, has := m["default"]; has {
		t.Fatalf("default must be dropped for a key scoped to test2: %v", m)
	}
	if !reflect.DeepEqual(m["test2"], []string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}) {
		t.Fatalf("test2 perms not capped at Read: %v", m["test2"])
	}
	if r["test2"] != "Read" || len(r) != 1 {
		t.Fatalf("test2 role must be Read, got %v", r)
	}

	// Write ceiling keeps Write on test2 and Read (the user's own) on default.
	m, r = narrowForAPIKey(matrix, roles, []string{"test2", "default"}, "Write", writePerms)
	if len(m["test2"]) != len(writePerms) || r["test2"] != "Write" {
		t.Fatalf("test2 under a Write ceiling should keep Write: %v %v", m["test2"], r)
	}
	if len(m["default"]) != len(readPerms) || r["default"] != "Read" {
		t.Fatalf("default stays Read (the user's own role): %v %v", m["default"], r)
	}

	// A cluster the user has nothing on is left out even when listed.
	m, r = narrowForAPIKey(matrix, roles, []string{"prod"}, "Admin", []string{"*"})
	if len(m) != 0 || len(r) != 0 {
		t.Fatalf("prod must be absent: %v %v", m, r)
	}

	// A global superuser gets the ceiling role on the listed clusters, and no
	// "*" entry — the key cannot reach clusters outside its list.
	m, r = narrowForAPIKey(auth.PermissionMatrix{"*": []string{"*"}}, nil, []string{"test2"}, "Read", readPerms)
	if _, has := m["*"]; has {
		t.Fatalf("no global entry on an exchanged token: %v", m)
	}
	if !reflect.DeepEqual(m["test2"], []string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}) || r["test2"] != "Read" {
		t.Fatalf("superuser key capped at Read on test2: %v %v", m, r)
	}
	if !m.HasForCluster("k8s.pods.read", "test2") || m.HasForCluster("k8s.pods.read", "default") || m.HasForCluster("k8s.pods.delete", "test2") {
		t.Fatalf("checks disagree with the narrowed matrix: %v", m)
	}
}

// keyTokenValidator signs a token as auth-service does and reads it back as
// the other services do, which is where the identity on the cluster comes from.
func keyTokenValidator(t *testing.T) (*security.JWTManager, *auth.JWTValidator) {
	t.Helper()
	mgr, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(mgr.JWKS())
	}))
	t.Cleanup(jwks.Close)
	return mgr, auth.NewJWTValidator(auth.JWKSConfig{JWKSURL: jwks.URL, Issuer: "iss", Audience: "aud"})
}

func TestAPIKeyTokenIdentityStaysWithinTheOwnersRole(t *testing.T) {
	const c = "c"
	all := []string{"*"}
	custom := []string{"k8s.pods.read", "k8s.pods.delete"}
	authenticated := auth.GroupAuthenticated
	cases := []struct {
		name         string
		matrix       auth.PermissionMatrix
		roles        map[string]string
		namespaces   []string
		ceiling      string
		ceilingPerms []string
		wantPerms    []string
		wantRole     string
		wantGroups   []string
	}{
		{"custom role under an Admin ceiling keeps its own group", auth.PermissionMatrix{c: custom}, map[string]string{c: "auditor"}, nil, "Admin", all,
			[]string{"k8s.pods.delete", "k8s.pods.read"}, "auditor", []string{authenticated, "kubeast:role:auditor"}},
		{"custom role under a Write ceiling keeps its own group", auth.PermissionMatrix{c: custom}, map[string]string{c: "auditor"}, nil, "Write", writePerms,
			[]string{"k8s.pods.delete", "k8s.pods.read"}, "auditor", []string{authenticated, "kubeast:role:auditor"}},
		{"custom role under a Read ceiling keeps its own group and loses the writes", auth.PermissionMatrix{c: custom}, map[string]string{c: "auditor"}, nil, "Read", readPerms,
			[]string{"k8s.pods.read"}, "auditor", []string{authenticated, "kubeast:role:auditor"}},
		{"Read under an Admin ceiling stays Read", auth.PermissionMatrix{c: readPerms}, map[string]string{c: "Read"}, nil, "Admin", all,
			[]string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Read", []string{authenticated, auth.GroupViewer}},
		{"Admin under a Read ceiling comes down to Read", auth.PermissionMatrix{c: all}, map[string]string{c: "Admin"}, nil, "Read", readPerms,
			[]string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Read", []string{authenticated, auth.GroupViewer}},
		{"a revoked grant leaves a global admin.* holder nothing on the cluster", auth.PermissionMatrix{"*": {"admin.audit.read"}}, nil, nil, "Admin", all,
			nil, "", []string{authenticated}},
		{"a global admin.* key is not added to a cluster grant", auth.PermissionMatrix{"*": {"admin.audit.read"}, c: readPerms}, map[string]string{c: "Read"}, nil, "Admin", all,
			[]string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Read", []string{authenticated, auth.GroupViewer}},
		{"a global * without a grant gets the ceiling's name", auth.PermissionMatrix{"*": all}, nil, nil, "Write", writePerms,
			[]string{"helm.releases.read", "helm.releases.upgrade", "k8s.deployments.read", "k8s.deployments.update", "k8s.pods.delete", "k8s.pods.read"}, "Write", []string{authenticated, auth.GroupOperator}},
		{"a global * with a custom grant keeps the whole cluster under an Admin ceiling", auth.PermissionMatrix{"*": all, c: custom}, map[string]string{c: "auditor"}, nil, "Admin", all,
			[]string{"*", "k8s.pods.delete", "k8s.pods.read"}, "Admin", []string{auth.GroupAdmin, authenticated}},
		{"a global * with a Read grant keeps the whole cluster under an Admin ceiling", auth.PermissionMatrix{"*": all, c: readPerms}, map[string]string{c: "Read"}, nil, "Admin", all,
			[]string{"*", "helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Admin", []string{auth.GroupAdmin, authenticated}},
		{"a global * with a custom grant comes down to a Write ceiling", auth.PermissionMatrix{"*": all, c: custom}, map[string]string{c: "auditor"}, nil, "Write", writePerms,
			[]string{"helm.releases.read", "helm.releases.upgrade", "k8s.deployments.read", "k8s.deployments.update", "k8s.pods.delete", "k8s.pods.read"}, "Write", []string{authenticated, auth.GroupOperator}},
		{"a namespace-limited custom role keeps its own group", auth.PermissionMatrix{c: custom}, map[string]string{c: "auditor"}, []string{"team-a"}, "Admin", all,
			[]string{"k8s.pods.delete", "k8s.pods.read"}, "auditor", []string{authenticated, "kubeast:role:auditor"}},
		{"a namespace-limited Read stays Read under an Admin ceiling", auth.PermissionMatrix{c: readPerms}, map[string]string{c: "Read"}, []string{"team-a"}, "Admin", all,
			[]string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Read", []string{authenticated, "kubeast:role:read"}},
		{"a namespace-limited Admin comes down to Read", auth.PermissionMatrix{c: all}, map[string]string{c: "Admin"}, []string{"team-a"}, "Read", readPerms,
			[]string{"helm.releases.read", "k8s.deployments.read", "k8s.pods.read"}, "Read", []string{authenticated, "kubeast:role:read"}},
	}
	mgr, validator := keyTokenValidator(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			narrowed, narrowedRoles := narrowForAPIKey(tc.matrix, tc.roles, []string{c}, tc.ceiling, tc.ceilingPerms)
			var namespaces map[string][]string
			if _, reached := narrowed[c]; reached && len(tc.namespaces) > 0 {
				namespaces = map[string][]string{c: tc.namespaces}
			}
			token, err := mgr.CreateAPIKeyToken("u1", "u1@example.com", "Member", narrowed, narrowedRoles, namespaces, 0, "key-1")
			if err != nil {
				t.Fatal(err)
			}
			payload, err := validator.Validate(token)
			if err != nil {
				t.Fatal(err)
			}
			if got := payload.Perms[c]; !slices.Equal(got, tc.wantPerms) {
				t.Errorf("permissions = %v, want %v", got, tc.wantPerms)
			}
			if got := payload.Roles[c]; got != tc.wantRole {
				t.Errorf("role = %q, want %q", got, tc.wantRole)
			}
			if _, groups := payload.Impersonation(c); !slices.Equal(groups, tc.wantGroups) {
				t.Errorf("groups = %v, want %v", groups, tc.wantGroups)
			}
		})
	}
}
