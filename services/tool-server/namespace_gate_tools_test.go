package main

import (
	"errors"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A namespace-scoped grant may search (the handler stays inside its
// namespaces) and read API schema, but not name a namespace outside the grant.
func TestNamespaceGate_FindAndExplain(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web"}); err != nil {
		t.Fatalf("find without a namespace passes (the handler scopes it): %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web", "namespace": "web"}); err != nil {
		t.Fatalf("find in an own namespace: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web", "namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("find in another namespace is refused: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_explain", map[string]interface{}{"resource": "pods"}); err != nil {
		t.Fatalf("explain returns schema, not objects: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_get_events", map[string]interface{}{"all_namespaces": true}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("events across namespaces still need a namespace from a scoped grant: %v", err)
	}
}
