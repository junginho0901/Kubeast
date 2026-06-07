// Package helm provides a thin wrapper over the Helm v3 SDK for
// listing, inspecting and (later) mutating Helm releases installed in
// the currently connected Kubernetes cluster.
//
// Design notes:
//   - Every exported method takes a context.Context first so a future
//     multi-cluster transition (see docs/helm-plan.md §10) can thread the
//     cluster identifier through ctx without signature churn.
//   - action.Configuration is NOT thread-safe; we build a fresh one per
//     call, scoped to the target namespace.
//   - The storage driver is fixed to "secrets" (Helm v3 default).
package helm

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"helm.sh/helm/v3/pkg/action"
	"k8s.io/cli-runtime/pkg/genericclioptions"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

// storageDriver is the Helm v3 default. Kept explicit because switching
// drivers (e.g. to "configmaps" or "sql") would break history lookups.
const storageDriver = "secrets"

// Service wraps the Helm v3 SDK. It is intentionally stateless beyond
// the cache and the references to its collaborators — every operation
// rebuilds an action.Configuration because Helm's storage clients are
// not safe for concurrent use across namespaces.
type Service struct {
	k8s   *k8s.Service
	cache *cache.Cache

	// getterFactory is swapped out in tests to inject a fake
	// genericclioptions.RESTClientGetter. In production it resolves the
	// per-cluster *rest.Config from ctx (the ?cluster= entry) and wraps it
	// in a restConfigGetter — see defaultGetter.
	getterFactory func(ctx context.Context, namespace string) (genericclioptions.RESTClientGetter, error)

	mu sync.Mutex
}

// NewService constructs a Helm service. The underlying k8s.Service is
// reused for namespace listing and shares the same kubeconfig hot-reload
// semantics (main.go wires a single k8s.Service per process).
func NewService(k8sSvc *k8s.Service, c *cache.Cache) *Service {
	s := &Service{
		k8s:   k8sSvc,
		cache: c,
	}
	s.getterFactory = s.defaultGetter
	return s
}

// defaultGetter derives a Helm REST getter from the per-cluster *rest.Config
// resolved from ctx (the request's ?cluster= entry). Called on every action —
// do not cache between calls; the bundle is rebuilt on kubeconfig rotation
// (Service.Invalidate) and re-read here each time.
func (s *Service) defaultGetter(ctx context.Context, namespace string) (genericclioptions.RESTClientGetter, error) {
	cfg, err := s.k8s.RESTConfigFor(ctx)
	if err != nil {
		return nil, err
	}
	return &restConfigGetter{cfg: cfg, namespace: namespace}, nil
}

// actionConfig builds a fresh *action.Configuration for the given namespace.
// Callers must not share the returned value across goroutines.
func (s *Service) actionConfig(ctx context.Context, namespace string) (*action.Configuration, error) {
	getter, err := s.getterFactory(ctx, namespace)
	if err != nil {
		return nil, fmt.Errorf("helm getter: %w", err)
	}
	if getter == nil {
		return nil, fmt.Errorf("kubeconfig not loaded")
	}

	cfg := new(action.Configuration)
	debugf := func(format string, v ...interface{}) {
		slog.Debug(fmt.Sprintf("helm: "+format, v...))
	}
	if err := cfg.Init(getter, namespace, storageDriver, debugf); err != nil {
		return nil, fmt.Errorf("init helm action config: %w", err)
	}
	return cfg, nil
}
