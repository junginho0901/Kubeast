package helm

import (
	"testing"

	"k8s.io/client-go/rest"
)

// Test that restConfigGetter surfaces exactly the *rest.Config it was built
// with — this is the contract that makes Helm target the ctx cluster's bundle
// (defaultGetter passes RESTConfigFor(ctx) here) instead of a kubeconfig file.
func TestRestConfigGetter_ToRESTConfig(t *testing.T) {
	cfg := &rest.Config{Host: "https://cluster-b.example:6443"}
	g := &restConfigGetter{cfg: cfg, namespace: "team-a"}

	got, err := g.ToRESTConfig()
	if err != nil {
		t.Fatalf("ToRESTConfig: %v", err)
	}
	if got != cfg {
		t.Fatalf("ToRESTConfig returned a different config: got %v want %v", got, cfg)
	}
	if got.Host != "https://cluster-b.example:6443" {
		t.Fatalf("wrong host threaded through: %q", got.Host)
	}
}

// ToRawKubeConfigLoader must honor the namespace (used by Helm for default
// namespace resolution) without touching any on-disk kubeconfig.
func TestRestConfigGetter_RawLoaderNamespace(t *testing.T) {
	g := &restConfigGetter{cfg: &rest.Config{Host: "https://x:6443"}, namespace: "team-a"}

	ns, _, err := g.ToRawKubeConfigLoader().Namespace()
	if err != nil {
		t.Fatalf("Namespace(): %v", err)
	}
	if ns != "team-a" {
		t.Fatalf("namespace not threaded: got %q want %q", ns, "team-a")
	}
}
