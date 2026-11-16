package k8s

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"sync"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// clusterHealth is a per-cluster circuit breaker + reachability flag (step 15).
// A request to an OPEN cluster fails fast (immediate 503) instead of waiting out
// the API-server timeout. Live requests that could not reach it count toward `threshold` before
// opening (so a single transient blip doesn't trip it); a health-check failure
// opens immediately (authoritative probe). Any success closes it. Absent =
// unknown → treated as CLOSED (we never fail-fast a cluster we haven't seen fail).
// After openFor one request tries the cluster (half-open) and holds the next openFor.
type clusterHealth struct {
	mu        sync.Mutex
	threshold int
	openFor   time.Duration
	now       func() time.Time
	fails     map[cluster.ID]int
	open      map[cluster.ID]time.Time // an open cluster: when a request may next try it
}

// defaultBreakerOpen is the open period of a breaker given none (ServiceOptions.BreakerOpen 0).
const defaultBreakerOpen = 30 * time.Second

// newClusterHealth is nil, the breaker off, for a threshold below 1 (MC_BREAKER_CONSECUTIVE_FAILS 0).
func newClusterHealth(threshold int, openFor time.Duration) *clusterHealth {
	if threshold < 1 {
		return nil
	}
	if openFor <= 0 {
		openFor = defaultBreakerOpen
	}
	return &clusterHealth{threshold: threshold, openFor: openFor, now: time.Now, fails: map[cluster.ID]int{}, open: map[cluster.ID]time.Time{}}
}

// recordFailure is a live request error: open the breaker once threshold is hit.
func (h *clusterHealth) recordFailure(id cluster.ID) {
	h.mu.Lock()
	h.fails[id]++
	if h.fails[id] >= h.threshold {
		h.open[id] = h.now().Add(h.openFor)
	}
	h.mu.Unlock()
}

// answered forgets id's failures while its breaker is closed; an open one waits for its trial.
func (h *clusterHealth) answered(id cluster.ID) {
	h.mu.Lock()
	if _, open := h.open[id]; !open {
		delete(h.fails, id)
	}
	h.mu.Unlock()
}

// recordSuccess closes the breaker — a single healthy response recovers it.
func (h *clusterHealth) recordSuccess(id cluster.ID) {
	h.mu.Lock()
	delete(h.fails, id)
	delete(h.open, id)
	h.mu.Unlock()
}

// setOpen is the authoritative health-check verdict (open immediately on fail).
func (h *clusterHealth) setOpen(id cluster.ID, open bool) {
	h.mu.Lock()
	if open {
		h.open[id] = h.now().Add(h.openFor)
		h.fails[id] = h.threshold
	} else {
		delete(h.open, id)
		delete(h.fails, id)
	}
	h.mu.Unlock()
}

func (h *clusterHealth) isOpen(id cluster.ID) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, open := h.open[id]
	return open
}

// admit says whether a request to id may go; a trial (its period over) gets the end of the next period it books.
func (h *clusterHealth) admit(id cluster.ID) (bool, time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	next, open := h.open[id]
	if !open {
		return true, time.Time{}
	}
	now := h.now()
	if now.Before(next) {
		return false, time.Time{}
	}
	booked := now.Add(h.openFor)
	h.open[id] = booked
	return true, booked
}

// unbook gives the next request the try that the trial which booked until booked did not use.
func (h *clusterHealth) unbook(id cluster.ID, booked time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if next, open := h.open[id]; open && next.Equal(booked) {
		h.open[id] = h.now()
	}
}

// rebook holds the open period again from now for the trial that booked until booked, as a failed trial does.
func (h *clusterHealth) rebook(id cluster.ID, booked time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if next, open := h.open[id]; open && next.Equal(booked) {
		h.open[id] = h.now().Add(h.openFor)
	}
}

// --- Service accessors (used by the fail-fast middleware + handlers). All
// nil-safe so a zero-value Service in unit tests behaves as "everything up". ---

// ClusterDown reports whether id's breaker is open (fail-fast). nil-safe.
func (s *Service) ClusterDown(id cluster.ID) bool {
	if s.health == nil {
		return false
	}
	return s.health.isOpen(id)
}

// AdmitToCluster reports whether a request to id may go; trial is non-zero for the one that tries an open breaker. nil-safe.
func (s *Service) AdmitToCluster(id cluster.ID) (ok bool, trial time.Time) {
	if s.health == nil {
		return true, time.Time{}
	}
	return s.health.admit(id)
}

// TrialAskedNothing gives the next request the try: the trial made no call to the cluster (a cache's answer or Kubeast's own). nil-safe.
func (s *Service) TrialAskedNothing(id cluster.ID, trial time.Time) {
	if s.health != nil {
		s.health.unbook(id, trial)
	}
}

// TrialUnanswered holds the breaker open another period: the cluster took the trial's calls and answered none below 500. nil-safe.
func (s *Service) TrialUnanswered(id cluster.ID, trial time.Time) {
	if s.health != nil {
		s.health.rebook(id, trial)
	}
}

// ClusterAnswered: the API server answered a request to id that is no trial; the failures go, an open breaker stays. nil-safe.
func (s *Service) ClusterAnswered(id cluster.ID) {
	if s.health != nil {
		s.health.answered(id)
	}
}

type clusterCallsKey struct{}

// ClusterCalls is what one request's calls to its cluster got, as answerNotice saw them.
type ClusterCalls struct {
	id       cluster.ID
	answered func()
	once     sync.Once
	// responded: a response of any status; unreached: a call that could not reach the cluster; unanswered: a call the
	// cluster took and answered 500 or more, or not before the deadline once its headers were sent.
	responded, unreached, unanswered atomic.Bool
}

// WithClusterCalls gives ctx a record of its calls to cluster id; answered runs once, at the API server's first answer
// below 500.
func WithClusterCalls(ctx context.Context, id cluster.ID, answered func()) (context.Context, *ClusterCalls) {
	calls := &ClusterCalls{id: id, answered: answered}
	return context.WithValue(ctx, clusterCallsKey{}, calls), calls
}

// carryClusterCalls gives plain the record of from and nothing else of it, for a read made apart from the request's
// values (as Kubeast, or once for everyone).
func carryClusterCalls(plain, from context.Context) context.Context {
	if calls, ok := from.Value(clusterCallsKey{}).(*ClusterCalls); ok {
		return context.WithValue(plain, clusterCallsKey{}, calls)
	}
	return plain
}

// Unreached says a call could not reach the cluster and none got a response, of whatever status.
func (c *ClusterCalls) Unreached() bool { return c.unreached.Load() && !c.responded.Load() }

// Unanswered says the cluster took a call and answered none below 500.
func (c *ClusterCalls) Unanswered() bool { return c.unanswered.Load() }

// answerNotice is the innermost transport of cluster id, under the namespace guard and the person check that answer on
// their own.
type answerNotice struct {
	base http.RoundTripper
	id   cluster.ID
}

func (t answerNotice) RoundTrip(req *http.Request) (*http.Response, error) {
	calls, ok := req.Context().Value(clusterCallsKey{}).(*ClusterCalls)
	if !ok || calls.id != t.id {
		return t.base.RoundTrip(req)
	}
	over := req.Context().Err() != nil
	var sent atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GetConn:      func(string) { sent.Store(false) }, // each of the transport's own tries starts unsent
		WroteHeaders: func() { sent.Store(true) },
	}))
	resp, err := t.base.RoundTrip(req)
	switch ended := req.Context().Err(); {
	case resp != nil:
		calls.responded.Store(true)
		if resp.StatusCode < http.StatusInternalServerError {
			calls.once.Do(calls.answered)
		} else {
			calls.unanswered.Store(true)
		}
	case err == nil:
	case ended == nil:
		calls.unreached.Store(true)
	case over || errors.Is(ended, context.Canceled):
		// Kubeast stopped waiting before the cluster could tell anything: the caller left, or the call came too late.
	case sent.Load():
		calls.unanswered.Store(true)
	default:
		calls.unreached.Store(true)
	}
	return resp, err
}

// MarkClusterDown records a request whose calls could not reach the cluster (ClusterCalls.Unreached); the breaker opens
// once the failure threshold is reached. nil-safe.
func (s *Service) MarkClusterDown(id cluster.ID) {
	if s.health != nil {
		s.health.recordFailure(id)
	}
}

// MarkClusterUp records a healthy response — closes the breaker. nil-safe.
func (s *Service) MarkClusterUp(id cluster.ID) {
	if s.health != nil {
		s.health.recordSuccess(id)
	}
}

// AllowRequest reports whether a request to id is within its rate limit. nil-safe
// / true when rate limiting is disabled.
func (s *Service) AllowRequest(id cluster.ID) bool {
	if s.limiters == nil {
		return true
	}
	return s.limiters.Allow(id)
}

// healthRegistry is the slice of the registry the checker needs. The concrete
// PostgresRegistry satisfies it; kept narrow so the checker is easy to test.
type healthRegistry interface {
	ListMeta(ctx context.Context) ([]cluster.Meta, error)
	UpdateHealth(ctx context.Context, id cluster.ID, status string) error
}

// HealthChecker periodically probes every registered cluster and records the
// result in both the in-memory state (for fail-fast) and clusters.health_status
// (for the UI). Probes run in parallel with a per-cluster timeout so one slow
// cluster can't stall the sweep.
type HealthChecker struct {
	svc      *Service
	registry healthRegistry
	interval time.Duration
	// writer, when set, says whether this replica writes clusters.health_status
	// this sweep: of several replicas one does, so the column does not flip
	// between their answers. Every replica still probes for its own breaker.
	writer statusWriter
	// listFailedAt: while the clusters cannot be listed (the database down), when that began; the verdicts stay as they were.
	listFailedAt time.Time
}

// statusWriter is pglock.Lock: true while this process holds the lock.
type statusWriter interface {
	Held(ctx context.Context) bool
}

func NewHealthChecker(svc *Service, registry healthRegistry, interval time.Duration) *HealthChecker {
	return &HealthChecker{svc: svc, registry: registry, interval: interval}
}

// WriteStatusWhen makes the checker write clusters.health_status only in the
// sweeps where w says this replica holds the writer's lock.
func (hc *HealthChecker) WriteStatusWhen(w statusWriter) { hc.writer = w }

// Run blocks until ctx is cancelled, sweeping every interval (plus once up front).
func (hc *HealthChecker) Run(ctx context.Context) {
	hc.sweep(ctx)
	t := time.NewTicker(hc.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			hc.sweep(ctx)
		}
	}
}

func (hc *HealthChecker) sweep(ctx context.Context) {
	metas, err := hc.registry.ListMeta(ctx)
	if err != nil {
		if hc.listFailedAt.IsZero() && ctx.Err() == nil {
			hc.listFailedAt = time.Now()
			slog.Warn("healthcheck: cannot list the clusters; keeping the last verdicts", "err", err, "since", hc.listFailedAt)
		}
		return
	}
	if !hc.listFailedAt.IsZero() {
		slog.Info("healthcheck: listing the clusters again", "failed_for", time.Since(hc.listFailedAt).Round(time.Second))
		hc.listFailedAt = time.Time{}
	}
	write := hc.writer == nil || hc.writer.Held(ctx)
	var wg sync.WaitGroup
	for _, m := range metas {
		wg.Add(1)
		go func(id cluster.ID) {
			defer wg.Done()
			up := hc.probe(ctx, id)
			status := "healthy"
			if !up {
				status = "disconnected"
			}
			// Authoritative probe: open/close the breaker immediately.
			if hc.svc.health != nil {
				hc.svc.health.setOpen(id, !up)
			}
			if !write {
				return
			}
			if uerr := hc.registry.UpdateHealth(ctx, id, status); uerr != nil {
				slog.Debug("healthcheck: update health failed", "id", id, "err", uerr)
			}
		}(m.ID)
	}
	wg.Wait()
}

// probe fetches /version against cluster id, bounded by a short timeout.
func (hc *HealthChecker) probe(ctx context.Context, id cluster.ID) bool {
	pctx, cancel := context.WithTimeout(auth.AsKubeast(cluster.WithID(ctx, id)), 5*time.Second)
	defer cancel()
	_, _, err := hc.svc.RawRequest(pctx, "GET", "/version")
	return err == nil
}
