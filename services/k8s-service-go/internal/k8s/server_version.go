package k8s

import (
	"context"
	"sync"
	"time"

	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
)

const serverVersionTTL = 10 * time.Minute

// serverVersionCache is asked once for everyone: the version is the same whoever asks, and each ask waits in the clientset's rate limiter.
type serverVersionCache struct {
	mu    sync.Mutex
	value string
	at    time.Time
	asks  flight.Group[string]
}

// serverVersion is the API server's GitVersion, asked at most every serverVersionTTL; the last one known when an ask fails.
func (b *clientBundle) serverVersion(ctx context.Context) string {
	c := &b.version
	c.mu.Lock()
	value, at := c.value, c.at
	c.mu.Unlock()
	if b.discovery == nil || (value != "" && time.Since(at) < serverVersionTTL) {
		return value
	}
	got, _, err := c.asks.Do(ctx, "", func(ctx context.Context) (string, error) {
		// none of the caller's values: the ask goes out as Kubeast itself
		plain, cancel := context.WithCancel(context.Background())
		defer context.AfterFunc(ctx, cancel)()
		defer cancel()
		sv, err := discovery.ToServerVersionInterfaceWithContext(b.discovery).ServerVersionWithContext(plain)
		if err != nil {
			return "", err
		}
		return sv.GitVersion, nil
	})
	if err != nil {
		return value
	}
	c.mu.Lock()
	c.value, c.at = got, time.Now()
	c.mu.Unlock()
	return got
}
