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

// serverVersionTTL is how old a version the features (resize) take; shownVersionTTL how old one the screens that show
// it (the overview, the cluster config, hygiene) take, so an upgrade shows soon and they show one version.
const (
	serverVersionTTL = 10 * time.Minute
	shownVersionTTL  = 30 * time.Second
)

// serverVersionCache is asked once for everyone: the version is the same whoever asks.
type serverVersionCache struct {
	mu    sync.Mutex
	value *version.Info
	at    time.Time
	asks  flight.Group[*version.Info]
}

// serverVersion is the API server's GitVersion, asked at most every serverVersionTTL; the last one known when an ask fails.
func (b *clientBundle) serverVersion(ctx context.Context) string {
	info, _ := b.serverVersionInfo(ctx, serverVersionTTL)
	if info == nil {
		return ""
	}
	return info.GitVersion
}

// clusterVersion is the version of the cluster in ctx for a screen that shows it, at most shownVersionTTL old.
func (s *Service) clusterVersion(ctx context.Context) (*version.Info, error) {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	return b.serverVersionInfo(ctx, shownVersionTTL)
}

// versionReader reads the server version as Kubeast itself, waiting behind no one's requests (ownVersion); a bundle made
// without it (tests) reads through its discovery client. nil when it has neither.
func (b *clientBundle) versionReader() discovery.ServerVersionInterfaceWithContext {
	switch {
	case b.ownVersion != nil:
		return b.ownVersion
	case b.discovery != nil:
		return discovery.ToServerVersionInterfaceWithContext(b.discovery)
	}
	return nil
}

// serverVersionInfo is the API server's version read at most maxAge ago, the last one known when an ask fails and the
// error only when none is. Callers do not change what it points to: every caller shares it.
func (b *clientBundle) serverVersionInfo(ctx context.Context, maxAge time.Duration) (*version.Info, error) {
	c := &b.version
	c.mu.Lock()
	value, at := c.value, c.at
	c.mu.Unlock()
	vr := b.versionReader()
	if vr == nil {
		return value, errNotLoaded
	}
	if value != nil && time.Since(at) < maxAge {
		return value, nil
	}
	got, _, err := c.asks.Do(ctx, "", func(ctx context.Context) (*version.Info, error) {
		// none of the caller's values but the record of its calls: the ask goes out as Kubeast itself
		plain, cancel := context.WithCancel(carryClusterCalls(context.Background(), ctx))
		defer context.AfterFunc(ctx, cancel)()
		defer cancel()
		return vr.ServerVersionWithContext(auth.AsKubeast(plain))
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
