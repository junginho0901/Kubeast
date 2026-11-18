package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/tools/clientcmd"
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

// With the proxy off kubectl reads the kubeconfig written here: its context names default, as the proxy's run kubeconfig
// does, so a call naming no namespace does not land in POD_NAMESPACE, Kubeast's own, and the credential is kept as sent.
func TestKubeconfigsWrittenForKubectlNameDefaultWhenNoNamespaceIsNamed(t *testing.T) {
	registered := func(namespace string) string {
		kc := "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://203.0.113.10:6443\n" +
			"contexts:\n- name: c\n  context:\n    cluster: c\n    user: u\n"
		if namespace != "" {
			kc += "    namespace: " + namespace + "\n"
		}
		return kc + "current-context: c\nusers:\n- name: u\n  user:\n    token: fake-token-for-tests\n"
	}
	for name, answer := range map[string]map[string]interface{}{
		"in-cluster":                     {"kubeconfig": "", "in_cluster": true},
		"registered, no namespace":       {"kubeconfig": registered(""), "in_cluster": false},
		"registered, another namespace":  {"kubeconfig": registered("team-a"), "in_cluster": false},
		"registered, Kubeast's own name": {"kubeconfig": registered(protectedInstall), "in_cluster": false},
	} {
		t.Run(name, func(t *testing.T) {
			resetKubeconfigCache()
			_, restore := mockK8sService(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(answer)
			})
			defer restore()
			path, err := resolveClusterKubeconfig(context.Background(), "c1", http.Header{})
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := clientcmd.LoadFromFile(path)
			if err != nil {
				t.Fatal(err)
			}
			current := cfg.Contexts[cfg.CurrentContext]
			if current == nil || current.Namespace != "default" {
				t.Fatalf("context %+v: kubectl would not take default", current)
			}
			if answer["in_cluster"] == false {
				if c, u := cfg.Clusters[current.Cluster], cfg.AuthInfos[current.AuthInfo]; c == nil || c.Server != "https://203.0.113.10:6443" || u == nil || u.Token != "fake-token-for-tests" {
					t.Fatalf("cluster %+v user %+v: the kubeconfig changed beyond its namespace", c, u)
				}
			}
		})
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

// A kubeconfig a replica was not told to drop is fetched again within 10 s: the line the multi-replica test holds
// every tool-server replica to after a kubeconfig change or a cluster delete.
func TestResolveClusterKubeconfig_FetchesAgainAfterTenSeconds(t *testing.T) {
	resetKubeconfigCache()
	now := time.Unix(1_700_000_000, 0)
	prevNow := kcNow
	kcNow = func() time.Time { return now }
	defer func() { kcNow = prevNow }()
	var calls int32
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()

	resolve := func(step string, want int32) {
		t.Helper()
		if _, err := resolveClusterKubeconfig(context.Background(), "self", http.Header{}); err != nil {
			t.Fatalf("%s: resolve: %v", step, err)
		}
		if n := atomic.LoadInt32(&calls); n != want {
			t.Fatalf("%s: k8s-service hit %d times, want %d", step, n, want)
		}
	}
	resolve("first call", 1)
	now = now.Add(10*time.Second - time.Millisecond)
	resolve("just under 10 s later", 1)
	now = now.Add(time.Millisecond)
	resolve("10 s later", 2)
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

// A kubectl run reads a cluster's kubeconfig while another call writes it again (every 10 s per person and cluster):
// it reads the old file or the new one whole, the path is never missing, and no temporary file stays behind.
func TestWriteKubeconfigFileNeverShowsAFileBeingWritten(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	path, err := writeKubeconfigFile("c-whole", "first")
	if err != nil {
		t.Fatalf("first write: %v", err)
	}
	if filepath.Dir(path) != filepath.Clean(dir) {
		t.Fatalf("written to %s, want a file in %s", path, dir)
	}
	big := strings.Repeat("a", 1<<20)
	small := strings.Repeat("b", 1<<16)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 100; i++ {
			blob := big
			if i%2 == 1 {
				blob = small
			}
			if _, err := writeKubeconfigFile("c-whole", blob); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for reads := 0; ; reads++ {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %d while writing: %v", reads, err)
		}
		if s := string(data); s != "first" && s != big && s != small {
			t.Fatalf("read %d got %d bytes, a file being written", reads, len(data))
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("write: %v", err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if perm := info.Mode().Perm(); perm != 0o600 {
				t.Errorf("kubeconfig perms = %o, want 600", perm)
			}
			if left, _ := filepath.Glob(filepath.Join(dir, "*.tmp-*")); len(left) != 0 {
				t.Errorf("temporary files left: %v", left)
			}
			return
		default:
		}
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
