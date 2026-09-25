package auth

import "testing"

// permMatches must agree with ai-service security.py and frontend
// utils/permissions.ts (same table in their tests).
func TestPermMatches(t *testing.T) {
	cases := []struct {
		pattern, perm string
		want          bool
	}{
		{"*", "resource.pod.delete", true},
		{"resource.pod.read", "resource.pod.read", true},
		{"resource.*.read", "resource.pod.read", true}, // middle wildcard (seeded roles)
		{"resource.*.create", "resource.namespace.create", true},
		{"resource.*.read", "resource.pod.logs", false},
		{"resource.*.read", "resource.pod.read.extra", false},
		{"ai.tool.*", "ai.tool.k8s_scale", true}, // trailing wildcard = rest
		{"ai.tool.*", "ai.tool", false},
		{"menu.*", "menu.workloads", true},
		{"resource.*", "resource.pod.read", true},
		{"admin.users.read", "admin.users.write", false},
	}
	for _, c := range cases {
		if got := permMatches(c.pattern, c.perm); got != c.want {
			t.Errorf("permMatches(%q, %q) = %v, want %v", c.pattern, c.perm, got, c.want)
		}
	}
	m := PermissionMatrix{"prod": {"resource.*.read"}, "alpha": {"resource.*.create"}}
	if !m.HasForCluster("resource.pod.read", "prod") || m.HasForCluster("resource.namespace.create", "prod") {
		t.Error("Write-style wildcard must grant in its own cluster only")
	}
}

func TestParsePermissions_MapForm(t *testing.T) {
	raw := map[string]any{
		"*":    []any{"admin.users.read"},
		"prod": []any{"menu.workloads", "resource.pod.read"},
		"bad":  "not-a-list", // skipped
	}
	m := ParsePermissions(raw)
	if m == nil {
		t.Fatal("map form should parse, got nil")
	}
	if got := len(m["prod"]); got != 2 {
		t.Errorf("prod perms = %d, want 2", got)
	}
	if _, ok := m["bad"]; ok {
		t.Error("non-list cluster value should be skipped")
	}
}

func TestParsePermissions_LegacyArrayRejected(t *testing.T) {
	// Legacy flat-array claim → nil (caller rejects with 401).
	if m := ParsePermissions([]any{"resource.pod.read"}); m != nil {
		t.Errorf("legacy array should parse to nil, got %v", m)
	}
	// Absent / wrong type → nil.
	if m := ParsePermissions(nil); m != nil {
		t.Errorf("nil claim should parse to nil, got %v", m)
	}
}

func TestParsePermissions_EmptyMapIsValid(t *testing.T) {
	m := ParsePermissions(map[string]any{})
	if m == nil {
		t.Fatal("empty map is a valid deny-all matrix, should not be nil")
	}
	if m.HasForCluster("resource.pod.read", "prod") {
		t.Error("empty matrix must grant nothing")
	}
}

func TestHasForCluster(t *testing.T) {
	m := PermissionMatrix{
		"*":    {"admin.users.read"},
		"prod": {"menu.workloads", "resource.pod.*"},
	}
	cases := []struct {
		perm, cluster string
		want          bool
	}{
		{"admin.users.read", "prod", true},  // global "*" entry applies everywhere
		{"admin.users.read", "dev", true},   // ...even to a cluster with no row
		{"resource.pod.read", "prod", true}, // glob match in cluster
		{"resource.pod.delete", "prod", true},
		{"menu.workloads", "prod", true},
		{"menu.workloads", "dev", false},     // not granted in dev → deny-by-default
		{"resource.pod.read", "dev", false},  // no dev entry
		{"resource.svc.read", "prod", false}, // not in prod's globs
	}
	for _, c := range cases {
		if got := m.HasForCluster(c.perm, c.cluster); got != c.want {
			t.Errorf("HasForCluster(%q,%q)=%v, want %v", c.perm, c.cluster, got, c.want)
		}
	}
}

func TestHasForCluster_Superuser(t *testing.T) {
	m := PermissionMatrix{"*": {"*"}}
	for _, cl := range []string{"prod", "dev", "anything", ""} {
		if !m.HasForCluster("resource.pod.delete", cl) {
			t.Errorf("superuser should pass for cluster %q", cl)
		}
	}
}
