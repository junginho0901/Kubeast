package handler

import (
	"reflect"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestUnknownPermissions_UsesTheCatalog(t *testing.T) {
	if got := unknownPermissions([]string{"menu.dashboard", "resource.*.read", "admin.*", "*"}); got != nil {
		t.Fatalf("catalog keys must be accepted: %v", got)
	}
	got := unknownPermissions([]string{"menu.dashboard", "resource.pod.read", "made.up", "resource.*.*.*"})
	if want := []string{"made.up", "resource.*.*.*", "resource.pod.read"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unknown = %v, want %v", got, want)
	}
}

func TestMissingPermissions_Ceiling(t *testing.T) {
	admin := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}}}
	if got := missingPermissions(admin, []string{"*", "admin.roles.*", "resource.node.shell"}, ""); got != nil {
		t.Fatalf("a global admin holds everything: %v", got)
	}

	limited := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"admin.users.*", "admin.roles.*", "menu.*", "resource.pod.read"}}}
	got := missingPermissions(limited, []string{"menu.dashboard", "admin.users.create", "resource.pod.read", "resource.*.read", "*", "admin.audit.read"}, "")
	if want := []string{"*", "admin.audit.read", "resource.*.read"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("missing = %v, want %v (a narrower grant never covers a wildcard)", got, want)
	}

	// Authoring a role (no cluster): cluster-scoped permissions count when
	// held on any cluster, since the token never carries them globally.
	devViewer := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"admin.roles.*"}, "dev": {"resource.*.read", "menu.*"}}}
	if got := missingPermissions(devViewer, []string{"admin.roles.create", "resource.pod.read", "menu.dashboard"}, ""); got != nil {
		t.Fatalf("held on dev counts for a role: %v", got)
	}
	if got := missingPermissions(devViewer, []string{"resource.*.delete", "admin.users.read"}, ""); !reflect.DeepEqual(got, []string{"admin.users.read", "resource.*.delete"}) {
		t.Fatalf("not held anywhere: %v", got)
	}

	// Per-cluster: what the actor holds on that cluster counts, another
	// cluster's grant does not.
	clusterAdmin := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"admin.users.update"}, "prod": {"*"}, "dev": {"resource.*.read"}}}
	if got := missingPermissions(clusterAdmin, []string{"resource.*.delete", "resource.helm.rollback"}, "prod"); got != nil {
		t.Fatalf("cluster admin on prod: %v", got)
	}
	got = missingPermissions(clusterAdmin, []string{"resource.*.read", "resource.*.delete"}, "dev")
	if want := []string{"resource.*.delete"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dev viewer granting write: %v, want %v", got, want)
	}
	if got := missingPermissions(clusterAdmin, []string{"resource.*.read"}, "staging"); !reflect.DeepEqual(got, []string{"resource.*.read"}) {
		t.Fatalf("no grant on staging: %v", got)
	}
}
