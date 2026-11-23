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

	"k8s.io/client-go/discovery"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
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
	counts    *breakerMetrics
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
	return &clusterHealth{threshold: threshold, openFor: openFor, now: time.Now, fails: map[cluster.ID]int{}, open: map[cluster.ID]time.Time{},
		counts: breakerCounts}
}

// recordFailure is a live request error: open the breaker once threshold is hit.
func (h *clusterHealth) recordFailure(id cluster.ID) {
	h.mu.Lock()
	h.fails[id]++
	if h.fails[id] >= h.threshold {
		h.openNow(id, breakerOpenedByRequests)
	}
	h.mu.Unlock()
}

// openNow holds id's breaker open for openFor from now, counting it as opened by by when it was closed. h.mu is held.
func (h *clusterHealth) openNow(id cluster.ID, by string) {
	if _, open := h.open[id]; !open {
		h.counts.opens.WithLabelValues(by).Inc()
	}
	h.open[id] = h.now().Add(h.openFor)
}

// openCount is how many clusters have an open breaker.
func (h *clusterHealth) openCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.open)
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
		h.openNow(id, breakerOpenedByHealthCheck)
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
		h.counts.refusals.Inc()
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

// TrialAskedNothing gives the next request the try: the cluster took no call of the trial (a cache's answer, Kubeast's own, a caller gone before the headers). nil-safe.
func (s *Service) TrialAskedNothing(id cluster.ID, trial time.Time) {
	if s.health != nil {
		s.health.unbook(id, trial)
	}
}

// TrialUnanswered holds the breaker open another period: the cluster took the trial's calls and the API server answered none. nil-safe.
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
	// responded: a response of any status; gotAnswer: one of the API server (apiServerAnswered); unreached: a call that
	// could not reach the cluster; unanswered: an error status from in front of the API server, or no answer before the
	// deadline or the caller's leaving once the call's headers went out.
	responded, gotAnswer, unreached, unanswered atomic.Bool
	// waitedOut: a read ran out its clusterReadWait; readWait sends the request's other reads of the cluster no more.
	waitedOut atomic.Bool
}

// WithClusterCalls gives ctx a record of its calls to cluster id; answered runs once, at the API server's first answer.
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

// Unanswered says the cluster took a call and the API server answered none.
func (c *ClusterCalls) Unanswered() bool { return c.unanswered.Load() && !c.gotAnswer.Load() }

// apiServerAnswered: a status below 400, or any status with the Audit-ID kube-apiserver puts on every answer it writes
// (WithAuditInit, the outermost filter of its handler chain). An error status without it came from in front of the
// API server: a proxy, an ingress, a load balancer, or the kubelet's refusal of an upgrade, which comes back as written.
func apiServerAnswered(resp *http.Response) bool {
	return resp.StatusCode < http.StatusBadRequest || resp.Header.Get(accesstrail.HeaderAuditID) != ""
}

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
	// HTTP/2 also calls WroteHeaders when writing them failed, and its pool skips GetConn once on a connection net/http
	// just handed it; both are rare, and read a call that did not reach the cluster as one it took.
	var sent atomic.Bool
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GetConn:      func(string) { sent.Store(false) }, // each of the transport's own tries starts unsent
		WroteHeaders: func() { sent.Store(true) },
	}))
	resp, err := t.base.RoundTrip(req)
	ended := req.Context().Err()
	if errors.Is(context.Cause(req.Context()), errReadWaitOver) {
		ended = context.DeadlineExceeded // readWait stopped waiting: a deadline, not a caller leaving
	}
	switch {
	case resp != nil:
		calls.responded.Store(true)
		if apiServerAnswered(resp) {
			calls.gotAnswer.Store(true)
			calls.once.Do(calls.answered)
		} else {
			calls.unanswered.Store(true)
		}
	case err == nil:
	case ended == nil:
		calls.unreached.Store(true)
	case over:
		// the call came after Kubeast had stopped waiting
	case sent.Load():
		// the cluster had the call; the deadline passed or the caller left (or Kubeast cancelled it) before an answer
		calls.unanswered.Store(true)
	case errors.Is(ended, context.Canceled):
		// the caller left before the call's headers went out
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
			verdict := hc.probe(ctx, id)
			if verdict == probeNone {
				return
			}
			status := "disconnected"
			if verdict == probeUp {
				status = "healthy"
			}
			// Authoritative probe: open/close the breaker immediately; any answer of the API server closes it, as a trial's does.
			if hc.svc.health != nil {
				hc.svc.health.setOpen(id, verdict == probeDown)
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

// probeBudget is how long the probe of one cluster waits for /version.
var probeBudget = 5 * time.Second

// probeVerdict is what a probe found of its cluster.
type probeVerdict int

const (
	// probeNone: its call did not go out before its time ended and ended with that time, or the sweep is stopping; the
	// last verdict stays.
	probeNone probeVerdict = iota
	// probeUp: the API server gave its version.
	probeUp
	// probeAnswered: the API server answered with no version (a 401, a 5xx of its own).
	probeAnswered
	// probeDown: no client for it, a call that could not reach it, an error status from in front of the API server, no
	// answer in probeBudget once it went out, or an error of Kubeast's own before any call that is not its time (a
	// credential plugin that fails).
	probeDown
)

// probe reads /version of cluster id as Kubeast itself, through the bundle's own client, which waits behind no one's
// requests (as /health's read), and reads what its call got from the record of its calls.
func (hc *HealthChecker) probe(ctx context.Context, id cluster.ID) probeVerdict {
	var vr discovery.ServerVersionInterfaceWithContext
	if b, err := hc.svc.For(ctx, id); err == nil {
		vr = b.versionReader()
	}
	if vr == nil {
		if ctx.Err() != nil {
			return probeNone
		}
		return probeDown
	}
	pctx, cancel := context.WithTimeout(auth.AsKubeast(cluster.WithID(ctx, id)), probeBudget)
	defer cancel()
	pctx, calls := WithClusterCalls(pctx, id, func() {})
	_, err := vr.ServerVersionWithContext(pctx)
	switch {
	case ctx.Err() != nil:
		return probeNone
	case err == nil:
		return probeUp
	case calls.gotAnswer.Load():
		return probeAnswered
	case calls.responded.Load(), calls.unreached.Load(), calls.unanswered.Load():
		return probeDown
	case pctx.Err() != nil && errors.Is(err, context.DeadlineExceeded):
		slog.Info("healthcheck: the probe's call did not go out within its time; keeping the last verdict", "id", id, "err", err)
		return probeNone
	}
	// refused by Kubeast before any call with an error of its own, not its time (a credential plugin that fails, also
	// after the probe's time: client-go runs it apart from the call's context)
	return probeDown
}
