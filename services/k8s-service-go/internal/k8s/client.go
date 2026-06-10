package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// clientBundle holds all Kubernetes clients derived from a single REST config.
// One bundle exists per managed cluster; it is swapped atomically when that
// cluster's kubeconfig is reloaded, so in-flight requests keep using the bundle
// they captured and never observe a torn state.
type clientBundle struct {
	clientset  *kubernetes.Clientset
	dynamic    dynamic.Interface
	discovery  discovery.DiscoveryInterface
	restConfig *rest.Config

	// prom caches this cluster's discovered Prometheus location. It lives on the
	// bundle (not the Service) so one cluster's Prometheus never leaks into
	// another, and a kubeconfig rotation that rebuilds the bundle re-discovers.
	prom *promCache
}

// Close releases resources held by the bundle. There are no long-lived
// informers yet; this is the cleanup hook for LRU eviction (load handling).
func (b *clientBundle) Close() error { return nil }

// Service is the core Kubernetes service. It resolves a clientBundle per cluster
// from a cluster.Registry, building each lazily on first use. Context-less
// accessors target the registry's default cluster; the *For(ctx) variants
// target the cluster carried in the request context.
type Service struct {
	registry      cluster.Registry
	bundles       sync.Map // map[cluster.ID]*atomic.Pointer[clientBundle]
	defaultBundle atomic.Pointer[clientBundle]

	watchEnabled bool

	cache *cache.Cache

	// Gateway API version cache
	gatewayAPIVersionMu    sync.RWMutex
	gatewayAPIVersionCache string

	// DRA API version cache
	draAPIVersionMu    sync.RWMutex
	draAPIVersionCache string

	// API resources cache
	apiResourcesMu    sync.RWMutex
	apiResourcesCache []metav1.APIResourceList
	apiResourcesAt    time.Time
}

var errNotLoaded = fmt.Errorf("kubeconfig not loaded")

// NewService creates a K8s service backed by registry. Failure isolation: if no
// clusters are registered yet (pre-Setup) or the default cluster is unreachable
// at startup, the service still starts; bundles are built lazily on first use.
func NewService(ctx context.Context, registry cluster.Registry, watchEnabled bool, c *cache.Cache) (*Service, error) {
	s := &Service{
		registry:     registry,
		watchEnabled: watchEnabled,
		cache:        c,
	}

	defaultID, err := registry.Default(ctx)
	if err != nil {
		// Not configured yet: no clusters registered (ErrNotFound), the schema
		// is still being created by auth-service, or the DB is booting. Start
		// anyway — bundles resolve lazily once a cluster is registered.
		if !errors.Is(err, cluster.ErrNotFound) {
			slog.Warn("k8s: cluster registry not ready at startup, continuing", "err", err)
		} else {
			slog.Info("k8s: no clusters registered yet; starting unconfigured")
		}
		return s, nil
	}
	if b, err := s.For(ctx, defaultID); err != nil {
		slog.Warn("k8s: default cluster unreachable at startup, continuing",
			"cluster", defaultID, "err", err)
	} else {
		s.defaultBundle.Store(b)
	}
	return s, nil
}

// buildClientBundle constructs a clientBundle from cluster.Info. The connection
// mode is chosen by which field is set. No connection test is performed — the
// build is lazy and the first API call surfaces an unreachable cluster.
func buildClientBundle(info cluster.Info) (*clientBundle, error) {
	var (
		cfg *rest.Config
		err error
	)
	switch {
	case info.InCluster:
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
	case info.KubeconfigBlob != "":
		cfg, err = clientcmd.RESTConfigFromKubeConfig([]byte(info.KubeconfigBlob))
		if err != nil {
			return nil, fmt.Errorf("kubeconfig blob: %w", err)
		}
	case info.KubeconfigPath != "":
		cfg, err = clientcmd.BuildConfigFromFlags("", info.KubeconfigPath)
		if err != nil {
			return nil, fmt.Errorf("kubeconfig %s: %w", info.KubeconfigPath, err)
		}
	default:
		home, _ := os.UserHomeDir()
		path := filepath.Join(home, ".kube", "config")
		cfg, err = clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, fmt.Errorf("default kubeconfig: %w", err)
		}
	}

	cfg.QPS = 100
	cfg.Burst = 200
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create clientset: %w", err)
	}
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create dynamic client: %w", err)
	}
	return &clientBundle{
		clientset:  clientset,
		dynamic:    dynClient,
		discovery:  clientset.Discovery(),
		restConfig: cfg,
		prom:       &promCache{},
	}, nil
}

// For returns the client bundle for cluster id, building and caching it on first
// access from the registry. Concurrent first-access is de-duplicated.
func (s *Service) For(ctx context.Context, id cluster.ID) (*clientBundle, error) {
	if v, ok := s.bundles.Load(id); ok {
		return v.(*atomic.Pointer[clientBundle]).Load(), nil
	}
	info, err := s.registry.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("registry.Get(%s): %w", id, err)
	}
	b, err := buildClientBundle(*info)
	if err != nil {
		return nil, fmt.Errorf("build bundle(%s): %w", id, err)
	}
	ptr := &atomic.Pointer[clientBundle]{}
	ptr.Store(b)
	actual, loaded := s.bundles.LoadOrStore(id, ptr)
	if loaded {
		b.Close() // another goroutine won the race
	}
	return actual.(*atomic.Pointer[clientBundle]).Load(), nil
}

// Default returns the bundle for the registry's default cluster.
func (s *Service) Default(ctx context.Context) (*clientBundle, error) {
	id, err := s.registry.Default(ctx)
	if err != nil {
		return nil, err
	}
	return s.For(ctx, id)
}

// ForCtx returns the bundle for the cluster carried in ctx, or the default
// cluster when none is set.
func (s *Service) ForCtx(ctx context.Context) (*clientBundle, error) {
	if id, ok := cluster.FromContext(ctx); ok && id != "" {
		return s.For(ctx, id)
	}
	return s.Default(ctx)
}

// ClusterKubeconfig returns the kubeconfig blob for cluster id, for tool-server's
// runtime per-cluster kubectl (step 14). inCluster=true means the cluster is
// reached via the in-cluster ServiceAccount and needs no kubeconfig file.
func (s *Service) ClusterKubeconfig(ctx context.Context, id cluster.ID) (blob string, inCluster bool, err error) {
	info, err := s.registry.Get(ctx, id)
	if err != nil {
		return "", false, err
	}
	if info.InCluster || info.IsSelfCluster {
		return "", true, nil
	}
	return info.KubeconfigBlob, false, nil
}

// Invalidate drops a cluster's cached bundle (e.g. after a kubeconfig rotation)
// so the next access rebuilds it from the registry — no rollout required.
func (s *Service) Invalidate(id cluster.ID) {
	if v, ok := s.bundles.LoadAndDelete(id); ok {
		v.(*atomic.Pointer[clientBundle]).Load().Close()
	}
	s.defaultBundle.Store(nil)
	s.invalidateCaches()
}

// defaultClientBundle resolves (and caches) the default cluster's bundle for the
// context-less accessors. Returns nil when nothing is configured yet.
func (s *Service) defaultClientBundle() *clientBundle {
	if b := s.defaultBundle.Load(); b != nil {
		return b
	}
	b, err := s.Default(context.Background())
	if err != nil {
		return nil
	}
	s.defaultBundle.Store(b)
	return b
}

// invalidateCaches clears state derived from a clientBundle.
func (s *Service) invalidateCaches() {
	s.apiResourcesMu.Lock()
	s.apiResourcesCache = nil
	s.apiResourcesAt = time.Time{}
	s.apiResourcesMu.Unlock()

	s.gatewayAPIVersionMu.Lock()
	s.gatewayAPIVersionCache = ""
	s.gatewayAPIVersionMu.Unlock()

	s.draAPIVersionMu.Lock()
	s.draAPIVersionCache = ""
	s.draAPIVersionMu.Unlock()

	if s.cache != nil {
		// Best-effort: ignore errors from Redis flush.
		_ = s.cache.FlushAll(context.Background())
	}
}

// --- Context-less accessors (default cluster) ---

// RESTConfig returns the default cluster's REST config (WebSocket/exec handlers).
func (s *Service) RESTConfig() *rest.Config {
	b := s.defaultClientBundle()
	if b == nil {
		return nil
	}
	return b.restConfig
}

// Clientset returns the default cluster's kubernetes clientset.
func (s *Service) Clientset() *kubernetes.Clientset {
	b := s.defaultClientBundle()
	if b == nil {
		return nil
	}
	return b.clientset
}

// Dynamic returns the default cluster's dynamic client.
func (s *Service) Dynamic() dynamic.Interface {
	b := s.defaultClientBundle()
	if b == nil {
		return nil
	}
	return b.dynamic
}

// Discovery returns the default cluster's discovery client.
func (s *Service) Discovery() discovery.DiscoveryInterface {
	b := s.defaultClientBundle()
	if b == nil {
		return nil
	}
	return b.discovery
}

// RestConfig returns the default cluster's REST config (SPDY/exec).
func (s *Service) RestConfig() *rest.Config { return s.RESTConfig() }

// --- Context-aware accessors (cluster from ctx) ---

// ClientsetFor returns the clientset for the cluster carried in ctx.
func (s *Service) ClientsetFor(ctx context.Context) (*kubernetes.Clientset, error) {
	b, err := s.ForCtx(ctx)
	if err != nil {
		return nil, err
	}
	return b.clientset, nil
}

// DynamicFor returns the dynamic client for the cluster carried in ctx.
func (s *Service) DynamicFor(ctx context.Context) (dynamic.Interface, error) {
	b, err := s.ForCtx(ctx)
	if err != nil {
		return nil, err
	}
	return b.dynamic, nil
}

// DiscoveryFor returns the discovery client for the cluster carried in ctx.
func (s *Service) DiscoveryFor(ctx context.Context) (discovery.DiscoveryInterface, error) {
	b, err := s.ForCtx(ctx)
	if err != nil {
		return nil, err
	}
	return b.discovery, nil
}

// RESTConfigFor returns the REST config for the cluster carried in ctx.
func (s *Service) RESTConfigFor(ctx context.Context) (*rest.Config, error) {
	b, err := s.ForCtx(ctx)
	if err != nil {
		return nil, err
	}
	return b.restConfig, nil
}

// --- Internal context-aware accessors (value-or-nil) ---
//
// These mirror the context-less accessors but target the cluster carried in
// ctx, returning nil when the cluster is unknown/unreachable. Service methods
// already nil-check the result (errNotLoaded), so an unknown cluster degrades
// to "not loaded" rather than panicking.

// bundleForCtx returns the bundle for the cluster in ctx, or the cached default
// bundle when none is set. Returns nil on any error so callers degrade to
// errNotLoaded. Uses defaultClientBundle for the no-cluster case so it never
// touches the registry when the default is already resolved.
func (s *Service) bundleForCtx(ctx context.Context) *clientBundle {
	if id, ok := cluster.FromContext(ctx); ok && id != "" {
		b, err := s.For(ctx, id)
		if err != nil {
			return nil
		}
		return b
	}
	return s.defaultClientBundle()
}

func (s *Service) clientsetCtx(ctx context.Context) *kubernetes.Clientset {
	if b := s.bundleForCtx(ctx); b != nil {
		return b.clientset
	}
	return nil
}

// clusterCacheKey namespaces a (shared Redis) cache key by the ctx cluster, so
// one cluster's cached value — overview totals, resource YAML, dependency graph
// — is never served for another. Falls back to "default" when no cluster is in
// ctx (the server's default-cluster fallback).
func (s *Service) clusterCacheKey(ctx context.Context, key string) string {
	prefix := "default"
	if id, ok := cluster.FromContext(ctx); ok && id != "" {
		prefix = string(id)
	}
	return prefix + "|" + key
}

func (s *Service) dynamicCtx(ctx context.Context) dynamic.Interface {
	if b := s.bundleForCtx(ctx); b != nil {
		return b.dynamic
	}
	return nil
}

func (s *Service) discoveryCtx(ctx context.Context) discovery.DiscoveryInterface {
	if b := s.bundleForCtx(ctx); b != nil {
		return b.discovery
	}
	return nil
}

func (s *Service) restConfigCtx(ctx context.Context) *rest.Config {
	if b := s.bundleForCtx(ctx); b != nil {
		return b.restConfig
	}
	return nil
}

// DynamicForCtx returns the dynamic client for the cluster carried in ctx
// (value-or-nil), used by the WebSocket multiplexer's watch loop.
func (s *Service) DynamicForCtx(ctx context.Context) dynamic.Interface {
	return s.dynamicCtx(ctx)
}

// Cache returns the cache instance.
func (s *Service) Cache() *cache.Cache { return s.cache }

// WatchEnabled reports whether hot-reload is configured for this service.
func (s *Service) WatchEnabled() bool { return s.watchEnabled }

// HealthCheck pings the default cluster's K8s API server.
func (s *Service) HealthCheck(ctx context.Context) error {
	b := s.defaultClientBundle()
	if b == nil {
		return errNotLoaded
	}
	_, err := b.clientset.Discovery().ServerVersion()
	return err
}

// --- Generic resource operations ---

// GetResource fetches a single resource by GVR.
func (s *Service) GetResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) (*unstructured.Unstructured, error) {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return nil, errNotLoaded
	}
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	}
	return dyn.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
}

// ListResources lists resources by GVR.
func (s *Service) ListResources(ctx context.Context, gvr schema.GroupVersionResource, namespace string, opts metav1.ListOptions) (*unstructured.UnstructuredList, error) {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return nil, errNotLoaded
	}
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace).List(ctx, opts)
	}
	return dyn.Resource(gvr).List(ctx, opts)
}

// DeleteResource deletes a resource by GVR.
func (s *Service) DeleteResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) error {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return errNotLoaded
	}
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}
	return dyn.Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
}

// PatchResource applies a strategic merge patch.
func (s *Service) PatchResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string, data []byte) (*unstructured.Unstructured, error) {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return nil, errNotLoaded
	}
	pt := types.StrategicMergePatchType
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace).Patch(ctx, name, pt, data, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	return dyn.Resource(gvr).Patch(ctx, name, pt, data, metav1.PatchOptions{FieldManager: "k8s-service"})
}

// CreateResource creates a resource from unstructured data.
func (s *Service) CreateResource(ctx context.Context, gvr schema.GroupVersionResource, namespace string, obj *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return nil, errNotLoaded
	}
	if namespace != "" {
		return dyn.Resource(gvr).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{FieldManager: "k8s-service"})
	}
	return dyn.Resource(gvr).Create(ctx, obj, metav1.CreateOptions{FieldManager: "k8s-service"})
}

// GetResourceYAML returns a resource as YAML string with caching.
func (s *Service) GetResourceYAML(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string, forceRefresh bool) (string, error) {
	cacheKey := s.clusterCacheKey(ctx, fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, namespace, name))

	if !forceRefresh {
		var cached string
		if s.cache.Get(ctx, cacheKey, &cached) {
			return cached, nil
		}
	}

	obj, err := s.GetResource(ctx, gvr, namespace, name)
	if err != nil {
		return "", err
	}

	// Remove managed fields for cleaner YAML
	obj.SetManagedFields(nil)

	data, err := json.Marshal(obj.Object)
	if err != nil {
		return "", err
	}

	yamlStr := jsonToYAML(data)
	s.cache.Set(ctx, cacheKey, yamlStr, 10*time.Second)
	return yamlStr, nil
}

// RawRequest performs a raw HTTP request to the K8s API.
func (s *Service) RawRequest(ctx context.Context, method, path string) ([]byte, int, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, http.StatusServiceUnavailable, errNotLoaded
	}
	req := cs.RESTClient().Verb(method).AbsPath(path)
	result := req.Do(ctx)
	rawBody, err := result.Raw()
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	var statusCode int
	result.StatusCode(&statusCode)
	return rawBody, statusCode, nil
}
