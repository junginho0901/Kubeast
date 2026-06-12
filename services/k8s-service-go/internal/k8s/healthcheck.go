package k8s

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// clusterHealth is a per-cluster circuit breaker + reachability flag (step 15).
// A request to an OPEN cluster fails fast (immediate 503) instead of waiting out
// the API-server timeout. Live request errors count toward `threshold` before
// opening (so a single transient blip doesn't trip it); a health-check failure
// opens immediately (authoritative probe). Any success closes it. Absent =
// unknown → treated as CLOSED (we never fail-fast a cluster we haven't seen fail).
type clusterHealth struct {
	mu        sync.Mutex
	threshold int
	fails     map[cluster.ID]int
	open      map[cluster.ID]bool
}

func newClusterHealth(threshold int) *clusterHealth {
	if threshold < 1 {
		threshold = 1
	}
	return &clusterHealth{threshold: threshold, fails: map[cluster.ID]int{}, open: map[cluster.ID]bool{}}
}

// recordFailure is a live request error: open the breaker once threshold is hit.
func (h *clusterHealth) recordFailure(id cluster.ID) {
	h.mu.Lock()
	h.fails[id]++
	if h.fails[id] >= h.threshold {
		h.open[id] = true
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
		h.open[id] = true
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
	return h.open[id]
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

// MarkClusterDown records a live connectivity error (opens the breaker once the
// failure threshold is reached). nil-safe.
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
}

func NewHealthChecker(svc *Service, registry healthRegistry, interval time.Duration) *HealthChecker {
	return &HealthChecker{svc: svc, registry: registry, interval: interval}
}

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
		slog.Debug("healthcheck: list clusters failed", "err", err)
		return
	}
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
			if uerr := hc.registry.UpdateHealth(ctx, id, status); uerr != nil {
				slog.Debug("healthcheck: update health failed", "id", id, "err", uerr)
			}
		}(m.ID)
	}
	wg.Wait()
}

// probe fetches /version against cluster id, bounded by a short timeout.
func (hc *HealthChecker) probe(ctx context.Context, id cluster.ID) bool {
	pctx, cancel := context.WithTimeout(cluster.WithID(ctx, id), 5*time.Second)
	defer cancel()
	_, _, err := hc.svc.RawRequest(pctx, "GET", "/version")
	return err == nil
}
