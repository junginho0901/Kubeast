package auth

import (
	"reflect"
	"testing"
)

func TestParseNamespaces(t *testing.T) {
	got := ParseNamespaces(map[string]any{"a": []any{"web", "api"}, "b": []any{}, "c": "nope", "d": []any{1, "x"}})
	want := map[string][]string{"a": {"web", "api"}, "d": {"x"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if ParseNamespaces(nil) != nil || ParseNamespaces([]any{"a"}) != nil || ParseNamespaces(map[string]any{"a": []any{}}) != nil {
		t.Fatal("missing, malformed or all-empty claims must parse to nil")
	}
}

func TestAllowedIn_And_HasPermissionIn(t *testing.T) {
	p := TokenPayload{
		Perms:      PermissionMatrix{"a": {"resource.*.read"}, "b": {"resource.*.read"}},
		Roles:      map[string]string{"a": "Read", "b": "Read"},
		Namespaces: map[string][]string{"a": {"web", "api"}},
	}
	if !p.AllowedIn("a", "web") || !p.AllowedIn("a", "api") {
		t.Fatal("listed namespaces must be allowed")
	}
	if p.AllowedIn("a", "db") || p.AllowedIn("a", "") {
		t.Fatal("another namespace, or none, must be refused for a scoped grant")
	}
	if !p.AllowedIn("b", "anything") || !p.AllowedIn("b", "") {
		t.Fatal("an unscoped cluster reaches every namespace")
	}
	if !p.HasPermissionIn("resource.pod.read", "a", "web") || p.HasPermissionIn("resource.pod.read", "a", "db") {
		t.Fatal("HasPermissionIn must honor the scope")
	}
	if p.HasPermissionIn("resource.pod.delete", "a", "web") {
		t.Fatal("a permission the role lacks stays refused inside the scope")
	}
	admin := TokenPayload{Perms: PermissionMatrix{"*": {"*"}}}
	if !admin.AllowedIn("a", "db") || !admin.HasPermissionIn("resource.pod.delete", "a", "db") {
		t.Fatal("a global admin is never namespace-scoped")
	}
}

func TestImpersonation_NamespaceScopedSystemRoleUsesTheRoleGroup(t *testing.T) {
	p := TokenPayload{Email: "u@x", Roles: map[string]string{"a": "Read", "b": "Read"}, Namespaces: map[string][]string{"a": {"web"}}}
	_, scoped := p.Impersonation("a")
	_, whole := p.Impersonation("b")
	if !reflect.DeepEqual(scoped, []string{GroupAuthenticated, "kubeast:role:read"}) {
		t.Fatalf("scoped Read must act as kubeast:role:read, got %v", scoped)
	}
	if !reflect.DeepEqual(whole, []string{GroupAuthenticated, GroupViewer}) {
		t.Fatalf("unscoped Read stays the viewer group, got %v", whole)
	}
}
