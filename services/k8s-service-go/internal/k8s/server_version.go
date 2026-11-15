package k8s

import (
	"context"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/version"
	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const serverVersionTTL = 10 * time.Minute

// serverVersionCache is asked once for everyone: the version is the same whoever asks, and each ask waits in the clientset's rate limiter.
type serverVersionCache struct {
	mu    sync.Mutex
	value *version.Info
	at    time.Time
	asks  flight.Group[*version.Info]
}

// serverVersion is the API server's GitVersion, asked at most every serverVersionTTL; the last one known when an ask fails.
func (b *clientBundle) serverVersion(ctx context.Context) string {
	info, _ := b.serverVersionInfo(ctx)
	if info == nil {
		return ""
	}
	return info.GitVersion
}

// clusterVersion is serverVersionInfo of the cluster in ctx.
func (s *Service) clusterVersion(ctx context.Context) (*version.Info, error) {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	return b.serverVersionInfo(ctx)
}

// serverVersionInfo is the API server's version as serverVersion keeps it, the last one known when an ask fails and the
// error only when none is. Callers do not change what it points to: every caller shares it.
func (b *clientBundle) serverVersionInfo(ctx context.Context) (*version.Info, error) {
	c := &b.version
	c.mu.Lock()
	value, at := c.value, c.at
	c.mu.Unlock()
	if b.discovery == nil {
		return value, errNotLoaded
	}
	if value != nil && time.Since(at) < serverVersionTTL {
		return value, nil
	}
	got, _, err := c.asks.Do(ctx, "", func(ctx context.Context) (*version.Info, error) {
		// none of the caller's values: the ask goes out as Kubeast itself
		plain, cancel := context.WithCancel(context.Background())
		defer context.AfterFunc(ctx, cancel)()
		defer cancel()
		return discovery.ToServerVersionInterfaceWithContext(b.discovery).ServerVersionWithContext(auth.AsKubeast(plain))
	})
	if err != nil {
		if value != nil {
			return value, nil
		}
		return nil, err
	}
	c.mu.Lock()
	c.value, c.at = got, time.Now()
	c.mu.Unlock()
	return got, nil
}
