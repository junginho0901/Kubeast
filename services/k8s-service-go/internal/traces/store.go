package traces

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ErrNotConfigured is a read on a cluster with no trace store entry.
var ErrNotConfigured = errors.New("trace store is not configured for this cluster")

// ErrInvalidRequest is a request the store is not asked (a bad trace ID, tag or scope name).
var ErrInvalidRequest = errors.New("invalid request")

// Store runs the reads for the configured clusters and keeps the per-user
// rate limit (per k8s-service replica).
type Store struct {
	cfg   Config
	tempo *tempo

	mu    sync.Mutex
	users map[string]*rate.Limiter
}

// New validates cfg and returns a store.
func New(cfg Config) (*Store, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Store{cfg: cfg, tempo: newTempo(cfg), users: map[string]*rate.Limiter{}}, nil
}

// Config returns the configuration the store was built with.
func (s *Store) Config() Config { return s.cfg }

// Configured reports whether cluster id has trace reads.
func (s *Store) Configured(_ context.Context, id string) bool {
	if s == nil {
		return false
	}
	_, ok := s.cfg.Clusters[id]
	return ok
}

// Allow takes one read from user's budget.
func (s *Store) Allow(user string) bool {
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

// Scope is who reads: the cluster, and the namespace a namespace-scoped
// caller names ("" = every namespace, for an unscoped grant).
type Scope struct {
	Cluster   string
	Namespace string
}

func (s *Store) matchers(sc Scope) ([]Matcher, map[string]string, error) {
	value, ok := s.cfg.Clusters[sc.Cluster]
	if !ok {
		return nil, nil, ErrNotConfigured
	}
	m := []Matcher{{Attribute: "resource." + s.cfg.ClusterAttribute, Value: value}}
	attrs := map[string]string{s.cfg.ClusterAttribute: value}
	if sc.Namespace != "" {
		m = append(m, Matcher{Attribute: "resource." + s.cfg.NamespaceAttribute, Value: sc.Namespace})
		attrs[s.cfg.NamespaceAttribute] = sc.Namespace
	}
	return m, attrs, nil
}

// scopedQuery is query with the scope in every spanset filter.
func (s *Store) scopedQuery(sc Scope, query string) (string, error) {
	m, _, err := s.matchers(sc)
	if err != nil {
		return "", err
	}
	return InjectScope(query, m)
}

// Search runs a TraceQL search on the scope's spans.
func (s *Store) Search(ctx context.Context, sc Scope, query string, start, end time.Time, limit, spss int) (SearchResult, error) {
	q, err := s.scopedQuery(sc, query)
	if err != nil {
		return SearchResult{}, err
	}
	if limit < 1 || limit > s.cfg.MaxTraces {
		limit = s.cfg.MaxTraces
	}
	if spss < 1 || spss > 10 {
		spss = 3
	}
	return s.tempo.search(ctx, q, start, end, limit, spss)
}

// Metrics runs a TraceQL metrics query (rate(), quantile_over_time() …) on
// the scope's spans.
func (s *Store) Metrics(ctx context.Context, sc Scope, query string, start, end time.Time, step time.Duration) (MetricsResult, error) {
	q, err := s.scopedQuery(sc, query)
	if err != nil {
		return MetricsResult{}, err
	}
	if step <= 0 {
		step = end.Sub(start) / 120
	}
	if step < 15*time.Second {
		step = 15 * time.Second
	}
	return s.tempo.metrics(ctx, q, start, end, step.Truncate(time.Second))
}

var traceIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{1,32}$`)

// CheckTraceID refuses what is not a trace ID: up to 32 hex digits (Tempo's
// search writes IDs without their leading zeros).
func CheckTraceID(id string) error {
	if !traceIDPattern.MatchString(id) {
		return fmt.Errorf("%w: a trace ID is up to 32 hex digits", ErrInvalidRequest)
	}
	return nil
}

// padHex is id in lower case with the leading zeros an ID of width hex digits
// has (Tempo leaves them out); what is not hex is returned as it is.
func padHex(id string, width int) string {
	if len(id) >= width || strings.Trim(id, "0123456789abcdefABCDEF") != "" {
		return strings.ToLower(id)
	}
	return strings.Repeat("0", width-len(id)) + strings.ToLower(id)
}

// Trace reads a trace by ID: only the spans of the scope's cluster and
// namespace come back (a trace may cross clusters).
func (s *Store) Trace(ctx context.Context, sc Scope, traceID string, start, end time.Time) (TraceResult, error) {
	if err := CheckTraceID(traceID); err != nil {
		return TraceResult{}, err
	}
	_, attrs, err := s.matchers(sc)
	if err != nil {
		return TraceResult{}, err
	}
	res, err := s.tempo.trace(ctx, padHex(traceID, 32), start, end, attrs)
	if err == nil && len(res.Spans) == 0 {
		return res, ErrNotFound // the trace has no span in the scope: as if it were not there
	}
	return res, err
}

var tagScopes = map[string]bool{"": true, "resource": true, "span": true, "intrinsic": true, "event": true, "link": true, "instrumentation": true}

var tagName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:/\-]{0,199}$`)

// Tags lists attribute names (scope "" = every scope) on the scope's spans,
// or one attribute's values (tag set, e.g. resource.service.name).
func (s *Store) Tags(ctx context.Context, sc Scope, scopeName, tag string, start, end time.Time) (TagsResult, error) {
	if !tagScopes[scopeName] {
		return TagsResult{}, fmt.Errorf("%w: scope is one of resource, span, intrinsic, event, link, instrumentation", ErrInvalidRequest)
	}
	if tag != "" && !tagName.MatchString(tag) {
		return TagsResult{}, fmt.Errorf("%w: tag %q", ErrInvalidRequest, tag)
	}
	q, err := s.scopedQuery(sc, "{}")
	if err != nil {
		return TagsResult{}, err
	}
	if tag != "" {
		return s.tempo.tagValues(ctx, tag, q, start, end)
	}
	res, err := s.tempo.tags(ctx, scopeName, q, start, end)
	if names, ok := res.Scopes["intrinsic"]; ok {
		kept := names[:0]
		for _, n := range names {
			if !refusedIntrinsics[n] {
				kept = append(kept, n)
			}
		}
		res.Scopes["intrinsic"] = kept
	}
	return res, err
}

// refusedIntrinsics are the intrinsics InjectScope refuses (they read the
// root span, the parent, the whole trace or tree positions): not offered.
var refusedIntrinsics = map[string]bool{
	"rootName": true, "rootServiceName": true, "rootService": true, "traceDuration": true, "parent": true,
	"trace:rootName": true, "trace:rootService": true, "trace:duration": true,
	"nestedSetLeft": true, "nestedSetRight": true, "nestedSetParent": true,
}

// Sample is one trace of a comparison: its ID and its slowest matched span.
type Sample struct {
	TraceID    string        `json:"traceId"`
	DurationMs float64       `json:"durationMs"`
	Spans      []MatchedSpan `json:"spans"`
}

// CompareResult sums up how long the matched spans took over a sample of
// matching traces (the newest, as Tempo returns them), with the fastest,
// the slowest and the ones around the median.
type CompareResult struct {
	Traces         int      `json:"traces"`
	P50Ms          float64  `json:"p50Ms"`
	P90Ms          float64  `json:"p90Ms"`
	MaxMs          float64  `json:"maxMs"`
	MinMs          float64  `json:"minMs"`
	Fastest        []Sample `json:"fastest"`
	Typical        []Sample `json:"typical"`
	Slowest        []Sample `json:"slowest"`
	EffectiveQuery string   `json:"effectiveQuery"`
}

// Compare searches up to limit traces and ranks them by their slowest
// matched span (the whole trace's duration may include spans outside the
// scope, so it is not used).
func (s *Store) Compare(ctx context.Context, sc Scope, query string, start, end time.Time, limit, perGroup int) (CompareResult, error) {
	found, err := s.Search(ctx, sc, query, start, end, limit, 3)
	res := CompareResult{EffectiveQuery: found.EffectiveQuery, Fastest: []Sample{}, Typical: []Sample{}, Slowest: []Sample{}}
	if err != nil {
		return res, err
	}
	if perGroup < 1 || perGroup > 5 {
		perGroup = 3
	}
	samples := make([]Sample, 0, len(found.Traces))
	for _, t := range found.Traces {
		smp := Sample{TraceID: t.TraceID, Spans: t.Spans}
		for _, sp := range t.Spans {
			if sp.DurationMs > smp.DurationMs {
				smp.DurationMs = sp.DurationMs
			}
		}
		samples = append(samples, smp)
	}
	sort.SliceStable(samples, func(i, j int) bool { return samples[i].DurationMs < samples[j].DurationMs })
	res.Traces = len(samples)
	if len(samples) == 0 {
		return res, nil
	}
	at := func(p float64) float64 { return samples[int(p*float64(len(samples)-1))].DurationMs }
	res.MinMs, res.P50Ms, res.P90Ms, res.MaxMs = samples[0].DurationMs, at(0.5), at(0.9), samples[len(samples)-1].DurationMs
	take := func(from, n int) []Sample {
		if from < 0 {
			from = 0
		}
		if from+n > len(samples) {
			n = len(samples) - from
		}
		return append([]Sample{}, samples[from:from+n]...)
	}
	res.Fastest = take(0, perGroup)
	res.Typical = take(len(samples)/2-perGroup/2, perGroup)
	res.Slowest = take(len(samples)-perGroup, perGroup)
	for i, j := 0, len(res.Slowest)-1; i < j; i, j = i+1, j-1 {
		res.Slowest[i], res.Slowest[j] = res.Slowest[j], res.Slowest[i]
	}
	return res, nil
}
