package handler

import (
	"reflect"
	"testing"

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
		{"auditor", "Write", "Write"}, // custom role: never ranked, capped at the ceiling
		{"", "Read", "Read"},
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
