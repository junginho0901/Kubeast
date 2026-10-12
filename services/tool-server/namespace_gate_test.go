package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestNamespaceGate(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	whole := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}}
	args := func(ns string) map[string]interface{} {
		if ns == "" {
			return map[string]interface{}{"resource_type": "pods"}
		}
		return map[string]interface{}{"resource_type": "pods", "namespace": ns}
	}
	if err := namespaceGate(whole, "c", "k8s_get_resources", args("")); err != nil {
		t.Fatalf("unscoped caller untouched: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_get_resources", args("web")); err != nil {
		t.Fatalf("own namespace: %v", err)
	}
	for name, a := range map[string]map[string]interface{}{"other": args("db"), "none": args("")} {
		err := namespaceGate(scoped, "c", "k8s_get_resources", a)
		if !errors.Is(err, errNamespaceScope) || !strings.Contains(err.Error(), "api, web") {
			t.Fatalf("%s: must be refused naming the scope: %v", name, err)
		}
	}
	if err := namespaceGate(scoped, "c", "get_cluster_overview", args("web")); !errors.Is(err, errNamespaceScope) || !strings.Contains(err.Error(), "spans the cluster") {
		t.Fatalf("a cluster-wide tool is refused: %v", err)
	}
	if err := namespaceGate(scoped, "other", "k8s_get_resources", args("")); err != nil {
		t.Fatalf("a cluster the grant is not scoped on passes: %v", err)
	}
}
