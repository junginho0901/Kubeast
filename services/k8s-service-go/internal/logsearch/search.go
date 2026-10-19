package logsearch

import (
	"context"
	"errors"
	"fmt"
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

// QueryRequest is a LogQL query written by hand or by the AI, run on one cluster (and
// one namespace, when Namespace is set) with the range already normalized.
type QueryRequest struct {
	Cluster   string
	Namespace string
	Query     string
	Start     time.Time
	End       time.Time
	Limit     int
	Forward   bool
	// Metric also runs a metric query (Result.Series, at Step when set);
	// without it one is refused with ErrNotLogQuery.
	Metric bool
	Step   time.Duration
}

// Query adds the cluster's matcher (when its store has a cluster label) and
// the namespace matcher to every stream selector of req.Query, then runs it.
// The query actually sent comes back as Result.EffectiveQuery.
func (s *Searcher) Query(ctx context.Context, req QueryRequest) (Result, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return Result{}, ErrNotConfigured
	}
	effective, err := InjectMatchers(req.Query, s.scope(value, req.Namespace))
	if err != nil {
		return Result{}, err
	}
	res, err := s.store.rangeQuery(ctx, store, effective, req.Start, req.End, req.Limit, req.Forward, req.Step, req.Metric)
	res.EffectiveQuery = effective
	return res, err
}

// scope is the matchers a query on cluster label value (and namespace) gets.
func (s *Searcher) scope(value, namespace string) []Matcher {
	var m []Matcher
	if s.cfg.Labels.Cluster != "" && value != "" {
		m = append(m, Matcher{Name: s.cfg.Labels.Cluster, Value: value})
	}
	if namespace != "" {
		m = append(m, Matcher{Name: s.cfg.Labels.Namespace, Value: namespace})
	}
	return m
}

// LabelsRequest asks for the label names (Label empty) or one label's values
// on a cluster's streams (one namespace's, when Namespace is set).
type LabelsRequest struct {
	Cluster   string
	Namespace string
	Label     string
	Start     time.Time
	End       time.Time
}

// Labels lists label names or values on the streams of req's cluster and
// namespace only: the store is asked with the same selector a structured
// search starts from.
func (s *Searcher) Labels(ctx context.Context, req LabelsRequest) (LabelsResult, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return LabelsResult{}, ErrNotConfigured
	}
	if err := CheckLabelName(req.Label); err != nil {
		return LabelsResult{}, err
	}
	return s.store.labels(ctx, store, req.Label, s.cfg.LogQL(Request{Namespace: req.Namespace}, value), req.Start, req.End)
}

// CheckLabelName refuses a label name Loki would not take ("" = none asked).
func CheckLabelName(name string) error {
	if name != "" && !labelName.MatchString(name) {
		return fmt.Errorf("%w: label name %q", ErrInvalidLogQL, name)
	}
	return nil
}

// Patterns runs req.Query (a stream selector) on the store's pattern
// ingester with the cluster and namespace matchers added.
func (s *Searcher) Patterns(ctx context.Context, req QueryRequest) (PatternsResult, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return PatternsResult{}, ErrNotConfigured
	}
	effective, err := InjectMatchers(req.Query, s.scope(value, req.Namespace))
	if err != nil {
		return PatternsResult{}, err
	}
	res, err := s.store.patterns(ctx, store, effective, req.Start, req.End)
	res.EffectiveQuery = effective
	return res, err
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
