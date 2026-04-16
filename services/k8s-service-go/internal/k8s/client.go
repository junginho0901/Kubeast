package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
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
// It is swapped atomically when the kubeconfig file is hot-reloaded, so
// in-flight requests keep using the bundle they captured and never observe a
// torn state.
type clientBundle struct {
	clientset  *kubernetes.Clientset
	dynamic    dynamic.Interface
	discovery  discovery.DiscoveryInterface
	restConfig *rest.Config
}

// Service is the core Kubernetes service providing access to all cluster resources.
type Service struct {
	active atomic.Pointer[clientBundle]

	kubeconfigPath string
	inCluster      bool
	watchEnabled   bool

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

// NewService creates a new K8s service.
//
// When watchEnabled is true and the kubeconfig file is missing at startup, the
// Service is returned without an active clientBundle; callers must invoke
// WatchKubeconfig so the first Create/Write event can populate it. In all other
// configurations an error is returned on failure.
func NewService(kubeconfigPath string, inCluster bool, watchEnabled bool, c *cache.Cache) (*Service, error) {
	s := &Service{
		kubeconfigPath: kubeconfigPath,
		inCluster:      inCluster,
		watchEnabled:   watchEnabled,
		cache:          c,
	}

	if inCluster {
		cfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		slog.Info("using in-cluster config")
		if err := s.installBundle(cfg); err != nil {
			return nil, err
		}
		return s, nil
	}

	if kubeconfigPath != "" && fileExists(kubeconfigPath) {
		if err := s.reloadFromPath(kubeconfigPath); err != nil {
			return nil, err
		}
		slog.Info("using kubeconfig", "path", kubeconfigPath)
		return s, nil
	}

	if watchEnabled {
		// Docker-mode first boot: file may not exist yet. Watcher will
		// populate the bundle when the file arrives.
		slog.Warn("kubeconfig not found; waiting for watcher", "path", kubeconfigPath)
		return s, nil
	}

	home, _ := os.UserHomeDir()
	defaultPath := filepath.Join(home, ".kube", "config")
	if err := s.reloadFromPath(defaultPath); err != nil {
		return nil, fmt.Errorf("default kubeconfig: %w", err)
	}
	slog.Info("using default kubeconfig", "path", defaultPath)
	return s, nil
}

// installBundle builds clients from a REST config and stores them atomically.
func (s *Service) installBundle(cfg *rest.Config) error {
	cfg.QPS = 100
	cfg.Burst = 200

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create clientset: %w", err)
	}
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return fmt.Errorf("create dynamic client: %w", err)
	}
	s.active.Store(&clientBundle{
		clientset:  clientset,
		dynamic:    dynClient,
		discovery:  clientset.Discovery(),
		restConfig: cfg,
	})
	return nil
}

// reloadFromPath rebuilds clients from the given kubeconfig file and atomically
// swaps them in. Caches derived from the previous clientset are flushed so the
// next request sees a consistent view of the new cluster.
func (s *Service) reloadFromPath(path string) error {
	cfg, err := clientcmd.BuildConfigFromFlags("", path)
	if err != nil {
		return fmt.Errorf("kubeconfig %s: %w", path, err)
	}
	if err := s.installBundle(cfg); err != nil {
		return err
	}
	s.invalidateCaches()
	return nil
}

// invalidateCaches clears state derived from the previous clientBundle.
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

// bundle returns the currently active clientBundle, or nil if the kubeconfig
// has not been loaded yet (docker-mode first boot before the watcher fires).
func (s *Service) bundle() *clientBundle {
	return s.active.Load()
}

// errNotLoaded is returned when the kubeconfig has not yet been loaded.
var errNotLoaded = fmt.Errorf("kubeconfig not loaded")

// RESTConfig returns the underlying REST config (for WebSocket handlers, etc.)
func (s *Service) RESTConfig() *rest.Config {
	b := s.bundle()
	if b == nil {
		return nil
	}
	return b.restConfig
}

// Clientset returns the kubernetes clientset.
func (s *Service) Clientset() *kubernetes.Clientset {
	b := s.bundle()
	if b == nil {
		return nil
	}
	return b.clientset
}

// Dynamic returns the dynamic client.
func (s *Service) Dynamic() dynamic.Interface {
	b := s.bundle()
	if b == nil {
		return nil
	}
	return b.dynamic
}

// Discovery returns the discovery client.
func (s *Service) Discovery() discovery.DiscoveryInterface {
	b := s.bundle()
	if b == nil {
		return nil
	}
	return b.discovery
}

// RestConfig returns the REST config for SPDY/exec connections.
func (s *Service) RestConfig() *rest.Config {
	return s.RESTConfig()
}

// Cache returns the cache instance.
func (s *Service) Cache() *cache.Cache {
	return s.cache
}

// KubeconfigPath returns the path that is watched for hot-reload.
func (s *Service) KubeconfigPath() string {
	return s.kubeconfigPath
}

// WatchEnabled reports whether hot-reload is configured for this service.
func (s *Service) WatchEnabled() bool {
	return s.watchEnabled
}

// HealthCheck pings the K8s API server.
func (s *Service) HealthCheck(ctx context.Context) error {
	b := s.bundle()
	if b == nil {
		return errNotLoaded
	}
	_, err := b.clientset.Discovery().ServerVersion()
	return err
}

// --- Generic resource operations ---

// GetResource fetches a single resource by GVR.
func (s *Service) GetResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) (*unstructured.Unstructured, error) {
	dyn := s.Dynamic()
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
	dyn := s.Dynamic()
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
	dyn := s.Dynamic()
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
	dyn := s.Dynamic()
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
	dyn := s.Dynamic()
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
	cacheKey := fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, namespace, name)

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
	cs := s.Clientset()
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

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
