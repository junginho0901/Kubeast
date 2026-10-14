package logsearch

import (
	"context"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Searcher runs searches for the configured clusters and keeps the per-user
// rate limit (per k8s-service replica).
type Searcher struct {
	cfg   Config
	store *loki

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

// Configured reports whether cluster id has log search.
func (s *Searcher) Configured(id string) bool {
	if s == nil {
		return false
	}
	_, ok := s.cfg.Clusters[id]
	return ok
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
	return s.store.search(ctx, req, s.cfg.Clusters[req.Cluster])
}
