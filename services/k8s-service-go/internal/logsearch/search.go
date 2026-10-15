package logsearch

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ErrNotConfigured is a search on a cluster with no log store.
var ErrNotConfigured = errors.New("log search is not configured for this cluster")

// Searcher runs searches for the configured clusters and keeps the per-user
// rate limit (per k8s-service replica).
type Searcher struct {
	cfg   Config
	store *loki

	// OwnStore returns the store a cluster names for itself (nil = none) and
	// OwnStoreClusters lists the clusters that name one; both nil = only the
	// deployment-wide store. A cluster's own store comes before the
	// deployment-wide one.
	OwnStore         func(ctx context.Context, id string) *Store
	OwnStoreClusters func(ctx context.Context) []string

	mu    sync.Mutex
	users map[string]*rate.Limiter
}

// New validates cfg and returns a searcher.
func New(cfg Config) (*Searcher, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Searcher{cfg: cfg, store: newLoki(cfg), users: map[string]*rate.Limiter{}}, nil
}

// Config returns the configuration the searcher was built with.
func (s *Searcher) Config() Config { return s.cfg }

// resolve picks cluster id's store and the value of the cluster label its
// streams carry there.
func (s *Searcher) resolve(ctx context.Context, id string) (Store, string, bool) {
	if s.OwnStore != nil {
		if own := s.OwnStore(ctx, id); own != nil {
			return *own, own.ClusterLabel, true
		}
	}
	if value, ok := s.cfg.Clusters[id]; ok && s.cfg.URL != "" {
		return s.cfg.global(), value, true
	}
	return Store{}, "", false
}

// Configured reports whether cluster id has log search.
func (s *Searcher) Configured(ctx context.Context, id string) bool {
	if s == nil {
		return false
	}
	_, _, ok := s.resolve(ctx, id)
	return ok
}

// ClusterIDs lists the clusters with log search, sorted: the deployment-wide
// map and those naming their own store.
func (s *Searcher) ClusterIDs(ctx context.Context) []string {
	seen := map[string]bool{}
	if s.cfg.URL != "" {
		for id := range s.cfg.Clusters {
			seen[id] = true
		}
	}
	if s.OwnStoreClusters != nil {
		for _, id := range s.OwnStoreClusters(ctx) {
			seen[id] = true
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Allow takes one search from user's budget.
func (s *Searcher) Allow(user string) bool {
	s.mu.Lock()
	lim, ok := s.users[user]
	if !ok {
		n := s.cfg.PerUserPerMinute
		lim = rate.NewLimiter(rate.Every(time.Minute/time.Duration(n)), n)
		s.users[user] = lim
	}
	s.mu.Unlock()
	return lim.Allow()
}

// Search runs a normalized request on its cluster's streams.
func (s *Searcher) Search(ctx context.Context, req Request) (Result, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return Result{}, ErrNotConfigured
	}
	return s.store.search(ctx, req, store, value)
}

// Status says where cluster id's log search reads from and whether that
// store answers (GET /api/v1/logsearch/status).
func (s *Searcher) Status(ctx context.Context, id string) map[string]interface{} {
	store, value, ok := s.resolve(ctx, id)
	if !ok {
		return map[string]interface{}{
			"available": false, "source": "none",
			"message": "no log store for this cluster: list it in features.logSearch.clusters or name its own store in Admin → Clusters",
		}
	}
	source := "global"
	if s.OwnStore != nil && s.OwnStore(ctx, id) != nil {
		source = "cluster"
	}
	healthy, msg := s.store.healthy(ctx, store)
	out := map[string]interface{}{
		"available":     healthy,
		"source":        source,
		"endpoint":      store.URL,
		"auth":          store.AuthHeader != "",
		"tenant":        store.Tenant,
		"cluster_label": value,
		"label_name":    s.cfg.Labels.Cluster,
	}
	if !healthy {
		out["message"] = msg
	}
	return out
}
