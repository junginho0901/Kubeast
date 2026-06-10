package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
)

// resetKubeconfigCache clears the package-global resolver cache so each test
// starts cold (the cache is shared process-wide).
func resetKubeconfigCache() {
	kcCacheMu.Lock()
	kcCache = map[string]cachedKubeconfig{}
	kcCacheMu.Unlock()
}

// mockK8sService stands in for k8s-service's /internal/clusters/{id}/kubeconfig.
// It records the paths + auth headers it saw so tests can assert routing.
func mockK8sService(t *testing.T, handler http.HandlerFunc) (url string, restore func()) {
	t.Helper()
	ts := httptest.NewServer(handler)
	prev := k8sServiceURL
	k8sServiceURL = ts.URL
	return ts.URL, func() {
		k8sServiceURL = prev
		ts.Close()
	}
}

func TestResolveClusterKubeconfig_External_WritesTempFile(t *testing.T) {
	resetKubeconfigCache()
	const blob = "apiVersion: v1\nkind: Config\n"
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/internal/clusters/prod/kubeconfig" {
			t.Errorf("unexpected path %q", got)
		}
		_, _ = w.Write([]byte(`{"kubeconfig":"` + "apiVersion: v1\\nkind: Config\\n" + `","in_cluster":false}`))
	})
	defer restore()

	path, err := resolveClusterKubeconfig(context.Background(), "prod", http.Header{})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if path == "" {
		t.Fatal("expected a kubeconfig path for an external cluster, got empty (would skip --kubeconfig)")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read temp kubeconfig: %v", err)
	}
	if string(data) != blob {
		t.Errorf("temp kubeconfig content = %q, want %q", string(data), blob)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("temp kubeconfig perms = %o, want 600 (private)", perm)
	}
}

func TestResolveClusterKubeconfig_InCluster_SynthesizesSAKubeconfig(t *testing.T) {
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()

	// kubectl has no in-cluster mode, so an in-cluster cluster still needs a
	// kubeconfig — synthesized from the pod's ServiceAccount (API server + CA).
	path, err := resolveClusterKubeconfig(context.Background(), "self", http.Header{})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if path == "" {
		t.Fatal("in-cluster path is empty — kubectl would hit localhost and fail")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read synthesized kubeconfig: %v", err)
	}
	if string(data) != inClusterKubeconfigYAML {
		t.Errorf("in-cluster kubeconfig content unexpected:\n%s", string(data))
	}
}

func TestResolveClusterKubeconfig_EmptyDefaultsToDefault(t *testing.T) {
	resetKubeconfigCache()
	var sawPath string
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()

	if _, err := resolveClusterKubeconfig(context.Background(), "", http.Header{}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if sawPath != "/internal/clusters/default/kubeconfig" {
		t.Errorf("empty cluster id resolved to %q, want the 'default' cluster", sawPath)
	}
}

func TestResolveClusterKubeconfig_CachesWithinTTL(t *testing.T) {
	resetKubeconfigCache()
	var calls int32
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()

	for i := 0; i < 3; i++ {
		if _, err := resolveClusterKubeconfig(context.Background(), "self", http.Header{}); err != nil {
			t.Fatalf("resolve #%d: %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Errorf("k8s-service hit %d times, want 1 (cached within TTL)", n)
	}
}

func TestResolveClusterKubeconfig_ForwardsAuthorization(t *testing.T) {
	resetKubeconfigCache()
	var sawAuth string
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()

	h := http.Header{}
	h.Set("Authorization", "Bearer abc.def")
	if _, err := resolveClusterKubeconfig(context.Background(), "self", h); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if sawAuth != "Bearer abc.def" {
		t.Errorf("forwarded Authorization = %q, want the caller's bearer (per-cluster RBAC gating)", sawAuth)
	}
}

func TestResolveClusterKubeconfig_PropagatesError(t *testing.T) {
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	defer restore()

	if _, err := resolveClusterKubeconfig(context.Background(), "denied", http.Header{}); err == nil {
		t.Fatal("expected an error when k8s-service denies the kubeconfig, got nil")
	}
}

func TestKubeconfigForCtx_PrefersCtxOverGlobal(t *testing.T) {
	prev := kubeconfigPath
	kubeconfigPath = "/legacy/global"
	defer func() { kubeconfigPath = prev }()

	// no ctx value → legacy global fallback (a direct/legacy call)
	if got := kubeconfigForCtx(context.Background()); got != "/legacy/global" {
		t.Errorf("fallback = %q, want the legacy global", got)
	}
	// ctx value set → use it, even when empty (in-cluster SA, no --kubeconfig)
	if got := kubeconfigForCtx(withKubeconfigPath(context.Background(), "")); got != "" {
		t.Errorf("in-cluster ctx = %q, want empty (override the global)", got)
	}
	if got := kubeconfigForCtx(withKubeconfigPath(context.Background(), "/per/req")); got != "/per/req" {
		t.Errorf("per-request ctx = %q, want /per/req", got)
	}
}

func TestSanitizeID(t *testing.T) {
	cases := map[string]string{
		"prod":             "prod",
		"my-cluster_1":     "my-cluster_1",
		"../../etc/passwd": "______etc_passwd",
		"a/b":              "a_b",
	}
	for in, want := range cases {
		if got := sanitizeID(in); got != want {
			t.Errorf("sanitizeID(%q) = %q, want %q", in, got, want)
		}
	}
}
