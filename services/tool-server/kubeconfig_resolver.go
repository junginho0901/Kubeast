// Per-cluster kubeconfig resolution (step 14). tool-server no longer holds a
// single mounted kubeconfig — it fetches the SELECTED cluster's registered
// kubeconfig from k8s-service at runtime (so a cluster added after deploy needs
// no rollout), writes it to a private temp file, and runs kubectl against it.
// in-cluster clusters use the ServiceAccount (no --kubeconfig).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ctxKey int

const kubeconfigCtxKey ctxKey = iota

func withKubeconfigPath(ctx context.Context, path string) context.Context {
	return context.WithValue(ctx, kubeconfigCtxKey, path)
}

// kubeconfigPathFromCtx returns the per-request kubeconfig path resolved by
// handleCall. ok=false means none was resolved (fall back to the legacy global).
func kubeconfigPathFromCtx(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(kubeconfigCtxKey).(string)
	return v, ok
}

// kubeconfigForCtx is what runKubectl passes to --kubeconfig: the per-request
// path resolved for the selected cluster ("" = in-cluster SA, no flag). Only
// when nothing was resolved (e.g. a direct/legacy call that never went through
// handleCall) does it fall back to the global mounted kubeconfigPath.
func kubeconfigForCtx(ctx context.Context) string {
	if p, ok := kubeconfigPathFromCtx(ctx); ok {
		return p
	}
	return kubeconfigPath
}

var (
	k8sServiceURL = envOrDefault("K8S_SERVICE_URL", "http://k8s-service:8002")
	kcHTTP        = &http.Client{Timeout: 10 * time.Second}
)

const kubeconfigTTL = 5 * time.Minute

// inClusterKubeconfigYAML targets the local API server using this pod's mounted
// ServiceAccount CA. The user identity is supplied by kubectl's --token (the
// passthrough), with tokenFile only as a fallback when passthrough is off.
const inClusterKubeconfigYAML = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    server: https://kubernetes.default.svc
  name: in-cluster
contexts:
- context:
    cluster: in-cluster
    user: in-cluster
  name: in-cluster
current-context: in-cluster
users:
- name: in-cluster
  user:
    tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
`

type cachedKubeconfig struct {
	path   string // "" = in-cluster ServiceAccount (no --kubeconfig)
	expiry time.Time
}

var (
	kcCacheMu sync.Mutex
	kcCache   = map[string]cachedKubeconfig{}
)

// resolveClusterKubeconfig returns the --kubeconfig path for clusterID (""
// = in-cluster SA), fetching + caching the registered kubeconfig. An empty
// clusterID defaults to "default" (single-cluster / unspecified back-compat).
func resolveClusterKubeconfig(ctx context.Context, clusterID string, headers http.Header) (string, error) {
	if clusterID == "" {
		clusterID = "default"
	}

	// The cache key is scoped to (cluster, caller token) so the per-user
	// authorization gate in k8s-service — the kubeconfig fetch returns 403 when
	// the user has no access to this cluster — is re-evaluated for every distinct
	// user at least once per TTL. Keying by clusterID alone let user B reuse a
	// kubeconfig that user A's authorized fetch had cached, skipping B's 403 check
	// (a per-cluster privilege escalation). Errors are never cached, so a user
	// without access is rejected on every attempt.
	key := kcCacheKey(clusterID, headers)

	kcCacheMu.Lock()
	if c, ok := kcCache[key]; ok && time.Now().Before(c.expiry) {
		kcCacheMu.Unlock()
		return c.path, nil
	}
	kcCacheMu.Unlock()

	blob, inCluster, err := fetchClusterKubeconfig(ctx, clusterID, headers)
	if err != nil {
		return "", err
	}

	// in-cluster clusters have no registered blob — kubectl can't talk to the
	// API on its own (it has no in-cluster mode), so synthesize a kubeconfig from
	// this pod's ServiceAccount mount (API server + CA). Auth still comes from the
	// --token passthrough (the user's identity), so per-user RBAC is unchanged.
	var path string
	if inCluster {
		path, err = writeKubeconfigFile(clusterID, inClusterKubeconfigYAML)
	} else if blob != "" {
		path, err = writeKubeconfigFile(clusterID, blob)
	}
	if err != nil {
		return "", err
	}

	kcCacheMu.Lock()
	kcCache[key] = cachedKubeconfig{path: path, expiry: time.Now().Add(kubeconfigTTL)}
	kcCacheMu.Unlock()
	return path, nil
}

// kcCacheKey scopes a cache entry to (cluster, caller). The kubeconfig blob is
// identical across users (it is the cluster's own credentials), but caching it
// under the cluster id alone would skip the per-user 403 gate for a second user
// within the TTL; hashing the bearer token forces a fresh authorized fetch per
// user. Tokenless/legacy calls fall back to the cluster id.
func kcCacheKey(clusterID string, headers http.Header) string {
	token := extractBearerToken(headers)
	if token == "" {
		return clusterID
	}
	sum := sha256.Sum256([]byte(token))
	return clusterID + "|" + hex.EncodeToString(sum[:16])
}

// invalidateClusterKubeconfig drops the cached kubeconfig for clusterID so the
// next tool call re-fetches it from k8s-service. Called after a kubeconfig
// rotation so AI tool calls pick up the new credentials immediately instead of
// waiting out the TTL.
func invalidateClusterKubeconfig(clusterID string) {
	if clusterID == "" {
		clusterID = "default"
	}
	kcCacheMu.Lock()
	for k := range kcCache { // drop every per-user entry for this cluster
		if k == clusterID || strings.HasPrefix(k, clusterID+"|") {
			delete(kcCache, k)
		}
	}
	kcCacheMu.Unlock()
	// The kubeconfig file is shared across users (named by cluster id), so remove
	// it once by its deterministic path.
	_ = os.Remove(filepath.Join(os.TempDir(), "tool-server-kubeconfig-"+sanitizeID(clusterID)))
}

func fetchClusterKubeconfig(ctx context.Context, clusterID string, headers http.Header) (blob string, inCluster bool, err error) {
	url := fmt.Sprintf("%s/internal/clusters/%s/kubeconfig", k8sServiceURL, clusterID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", false, err
	}
	if auth := headers.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}

	resp, err := kcHTTP.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("kubeconfig fetch for %q: %w", clusterID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("kubeconfig fetch for %q: status %d", clusterID, resp.StatusCode)
	}

	var body struct {
		Kubeconfig string `json:"kubeconfig"`
		InCluster  bool   `json:"in_cluster"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false, err
	}
	return body.Kubeconfig, body.InCluster, nil
}

func writeKubeconfigFile(clusterID, blob string) (string, error) {
	path := filepath.Join(os.TempDir(), "tool-server-kubeconfig-"+sanitizeID(clusterID))
	if err := os.WriteFile(path, []byte(blob), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// sanitizeID keeps the temp filename safe regardless of the cluster id (ids are
// slugs, but never trust an id in a path).
func sanitizeID(id string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '_'
		}
	}, id)
}
