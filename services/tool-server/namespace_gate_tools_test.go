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

// Asking for every namespace stays inside a limited grant whichever way the flag comes and whatever namespace goes with it.
func TestNamespaceGate_AllNamespacesStaysInsideTheGrant(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	for _, tool := range []string{"k8s_get_resources", "k8s_get_events"} {
		for _, flag := range []interface{}{true, "true", "TRUE", float64(1)} {
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"namespace": "web", "all_namespaces": flag}); !errors.Is(err, errNamespaceScope) {
				t.Errorf("%s with an own namespace and all_namespaces=%v: %v", tool, flag, err)
			}
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"all_namespaces": flag}); !errors.Is(err, errNamespaceScope) {
				t.Errorf("%s with all_namespaces=%v alone: %v", tool, flag, err)
			}
		}
		for _, flag := range []interface{}{false, "false", nil} {
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"namespace": "web", "all_namespaces": flag}); err != nil {
				t.Errorf("%s in an own namespace with all_namespaces=%v: %v", tool, flag, err)
			}
		}
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "x", "all_namespaces": true}); !errors.Is(err, errNamespaceScope) {
		t.Errorf("a tool that narrows by itself, the flag named: %v", err)
	}
	if err := namespaceGate(scoped, "other", "k8s_get_resources", map[string]interface{}{"all_namespaces": true}); err != nil {
		t.Errorf("limited on another cluster only: %v", err)
	}
	whole := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}}
	if err := namespaceGate(whole, "c", "k8s_get_resources", map[string]interface{}{"namespace": "web", "all_namespaces": true}); err != nil {
		t.Errorf("no limit: %v", err)
	}
}
