package handler

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestNodeShellImage(t *testing.T) {
	allowed := []string{"docker.io/library/busybox:latest", " registry.internal/debug:1 "}
	cases := []struct {
		req  string
		want string
		ok   bool
	}{
		{"", "docker.io/library/busybox:latest", true},
		{"docker.io/library/busybox:latest", "docker.io/library/busybox:latest", true},
		{"registry.internal/debug:1", "registry.internal/debug:1", true},
		{"docker.io/library/busybox", "", false}, // tag differs
		{"evil.example/rootkit:latest", "", false},
	}
	for _, c := range cases {
		got, err := nodeShellImage(allowed, c.req)
		if c.ok && (err != nil || got != c.want) {
			t.Fatalf("nodeShellImage(%q) = %q, %v; want %q", c.req, got, err, c.want)
		}
		if !c.ok && err == nil {
			t.Fatalf("nodeShellImage(%q) must be rejected", c.req)
		}
	}
	if _, err := nodeShellImage(nil, ""); err == nil {
		t.Fatal("empty allow list must reject")
	}
}

func TestEnsureNodeShellNamespace(t *testing.T) {
	cs := fake.NewSimpleClientset()
	ctx := context.Background()
	if err := ensureNodeShellNamespace(ctx, cs, "kubeast-node-shell"); err != nil {
		t.Fatal(err)
	}
	ns, err := cs.CoreV1().Namespaces().Get(ctx, "kubeast-node-shell", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if ns.Labels["pod-security.kubernetes.io/enforce"] != "privileged" {
		t.Fatalf("namespace must be labelled privileged, got %v", ns.Labels)
	}
	// idempotent
	if err := ensureNodeShellNamespace(ctx, cs, "kubeast-node-shell"); err != nil {
		t.Fatal(err)
	}
}
