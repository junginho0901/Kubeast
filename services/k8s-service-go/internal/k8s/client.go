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
	"time"

	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/cache"
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

// Service is the core Kubernetes service providing access to all cluster resources.
type Service struct {
	clientset  *kubernetes.Clientset
	dynamic    dynamic.Interface
	discovery  discovery.DiscoveryInterface
	restConfig *rest.Config
	cache      *cache.Cache

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
func NewService(kubeconfigPath string, inCluster bool, c *cache.Cache) (*Service, error) {
	var cfg *rest.Config
	var err error

	if inCluster {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
		slog.Info("using in-cluster config")
	} else if kubeconfigPath != "" && fileExists(kubeconfigPath) {
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfigPath)
		if err != nil {
			return nil, fmt.Errorf("kubeconfig %s: %w", kubeconfigPath, err)
		}
		slog.Info("using kubeconfig", "path", kubeconfigPath)
	} else {
		home, _ := os.UserHomeDir()
		defaultPath := filepath.Join(home, ".kube", "config")
		cfg, err = clientcmd.BuildConfigFromFlags("", defaultPath)
		if err != nil {
			return nil, fmt.Errorf("default kubeconfig: %w", err)
		}
		slog.Info("using default kubeconfig", "path", defaultPath)
	}

	// Connection pool for high concurrency
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

	return &Service{
		clientset:  clientset,
		dynamic:    dynClient,
		discovery:  clientset.Discovery(),
		restConfig: cfg,
		cache:      c,
	}, nil
}

// RESTConfig returns the underlying REST config (for WebSocket handlers, etc.)
func (s *Service) RESTConfig() *rest.Config {
	return s.restConfig
}

// Clientset returns the kubernetes clientset.
func (s *Service) Clientset() *kubernetes.Clientset {
	return s.clientset
}

// Dynamic returns the dynamic client.
func (s *Service) Dynamic() dynamic.Interface {
	return s.dynamic
}

// RestConfig returns the REST config for SPDY/exec connections.
func (s *Service) RestConfig() *rest.Config {
	return s.restConfig
}

// Cache returns the cache instance.
func (s *Service) Cache() *cache.Cache {
	return s.cache
}

// HealthCheck pings the K8s API server.
func (s *Service) HealthCheck(ctx context.Context) error {
	_, err := s.clientset.Discovery().ServerVersion()
	return err
}

// --- Generic resource operations ---

// GetResource fetches a single resource by GVR.
func (s *Service) GetResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) (*unstructured.Unstructured, error) {
	if namespace != "" {
		return s.dynamic.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	}
	return s.dynamic.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
}

// ListResources lists resources by GVR.
func (s *Service) ListResources(ctx context.Context, gvr schema.GroupVersionResource, namespace string, opts metav1.ListOptions) (*unstructured.UnstructuredList, error) {
	if namespace != "" {
		return s.dynamic.Resource(gvr).Namespace(namespace).List(ctx, opts)
	}
	return s.dynamic.Resource(gvr).List(ctx, opts)
}

// DeleteResource deletes a resource by GVR.
func (s *Service) DeleteResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) error {
	if namespace != "" {
		return s.dynamic.Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}
	return s.dynamic.Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
}

// PatchResource applies a strategic merge patch.
func (s *Service) PatchResource(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string, data []byte) (*unstructured.Unstructured, error) {
	pt := types.StrategicMergePatchType
	if namespace != "" {
		return s.dynamic.Resource(gvr).Namespace(namespace).Patch(ctx, name, pt, data, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	return s.dynamic.Resource(gvr).Patch(ctx, name, pt, data, metav1.PatchOptions{FieldManager: "k8s-service"})
}

// CreateResource creates a resource from unstructured data.
func (s *Service) CreateResource(ctx context.Context, gvr schema.GroupVersionResource, namespace string, obj *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	if namespace != "" {
		return s.dynamic.Resource(gvr).Namespace(namespace).Create(ctx, obj, metav1.CreateOptions{FieldManager: "k8s-service"})
	}
	return s.dynamic.Resource(gvr).Create(ctx, obj, metav1.CreateOptions{FieldManager: "k8s-service"})
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
	req := s.clientset.RESTClient().Verb(method).AbsPath(path)
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
