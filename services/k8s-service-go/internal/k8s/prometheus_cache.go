package k8s

import (
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// promQueryCache coalesces concurrent identical Prometheus queries (singleflight)
// and caches each result for a short TTL (step 15) — so many users or a fast
// auto-refresh don't fan out into a flood of identical proxy calls. Keys embed
// the cluster id so results never cross clusters. ttl<=0 disables caching but
// keeps the singleflight coalescing.
type promQueryCache struct {
	ttl time.Duration
	sf  singleflight.Group
	mu  sync.Mutex
	m   map[string]promCacheEntry
}

type promCacheEntry struct {
	data   []map[string]interface{}
	expiry time.Time
}

func newPromQueryCache(ttl time.Duration) *promQueryCache {
	return &promQueryCache{ttl: ttl, m: map[string]promCacheEntry{}}
}

func (c *promQueryCache) get(key string) ([]map[string]interface{}, bool) {
	if c == nil || c.ttl <= 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || time.Now().After(e.expiry) {
		return nil, false
	}
	return e.data, true
}

func (c *promQueryCache) set(key string, data []map[string]interface{}) {
	if c == nil || c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	c.m[key] = promCacheEntry{data: data, expiry: time.Now().Add(c.ttl)}
	c.mu.Unlock()
}

// clear drops all cached results (called when a cluster's caches are invalidated,
// e.g. a kubeconfig rotation).
func (c *promQueryCache) clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.m = map[string]promCacheEntry{}
	c.mu.Unlock()
}

// do returns the query result for key, coalescing concurrent callers and serving
// a fresh cached value when available.
func (c *promQueryCache) do(key string, fetch func() ([]map[string]interface{}, error)) ([]map[string]interface{}, error) {
	if c == nil {
		return fetch()
	}
	if d, ok := c.get(key); ok {
		return d, nil
	}
	v, err, _ := c.sf.Do(key, func() (interface{}, error) {
		if d, ok := c.get(key); ok { // another caller filled it while we waited
			return d, nil
		}
		d, err := fetch()
		if err != nil {
			return nil, err
		}
		c.set(key, d)
		return d, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]map[string]interface{}), nil
}
