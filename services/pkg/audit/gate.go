package audit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// ErrUnavailable is the error behind every refusal: the audit store cannot
// take a write and the service runs fail-closed (docs/audit-log-plan.md §2 D4).
var ErrUnavailable = errors.New("audit unavailable")

// Pinger reports whether the store can take a write right now.
type Pinger interface {
	Ping(ctx context.Context) error
}

// WriteProber checks that a write would land without keeping a row
// (PostgresStore: an INSERT rolled back). Guarded asks it after a write failed,
// since a store that answers a ping can still refuse rows (a full disk, a lock,
// a trigger).
type WriteProber interface {
	ProbeWrite(ctx context.Context) error
}

// Readier is what handlers ask before an audited action runs.
type Readier interface {
	// Ready returns nil when a record written now would land in the store, or
	// an error wrapping ErrUnavailable when the action must not run.
	Ready(ctx context.Context) error
}

// FailClosedEnabled reports AUDIT_FAIL_CLOSED (default true): with the audit
// store unreachable, audited actions are refused with 503 instead of running
// unrecorded. Off restores the log-and-continue behaviour.
func FailClosedEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("AUDIT_FAIL_CLOSED")))
	return v != "false" && v != "0" && v != "off"
}

// BootWait is how long a service waits at start-up for the audit database
// (AUDIT_DB_WAIT_SEC, default 90) before it gives up and exits.
func BootWait() time.Duration {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("AUDIT_DB_WAIT_SEC"))); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 90 * time.Second
}

// WaitReady pings until the store answers or ctx ends. Every failed attempt
// is logged so a pod stuck here says why.
func WaitReady(ctx context.Context, p Pinger, every time.Duration) error {
	for attempt := 1; ; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := p.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		slog.Warn("audit: database not reachable yet", "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return fmt.Errorf("audit database: %w (last error: %v)", ctx.Err(), err)
		case <-time.After(every):
		}
	}
}

// Status is the audit writer's state as reported on /health.
type Status struct {
	Writer        string     `json:"writer"`
	FailClosed    bool       `json:"fail_closed"`
	Ready         bool       `json:"ready"`
	WriteFailures int64      `json:"write_failures"`
	LastError     string     `json:"last_error,omitempty"`
	LastErrorAt   *time.Time `json:"last_error_at,omitempty"`
}

// Statuser exposes Status for health endpoints.
type Statuser interface {
	Status(ctx context.Context) Status
}

// Guarded wraps a Store for fail-closed operation: it counts write failures,
// keeps the last one, and answers Ready by pinging the store (cached for a
// short window) so handlers can refuse to run an action that would go
// unrecorded. After a failed write it also probes a write (WriteProber) until
// one lands again: the database may answer while the audit table takes no row.
// With failClosed off, Ready always passes and the wrapper only counts.
type Guarded struct {
	Store
	pinger     Pinger
	prober     WriteProber
	failClosed bool
	ttl        time.Duration

	mu        sync.Mutex
	checkedAt time.Time
	lastPing  error
	broken    bool // a write failed and none has landed since
	probedAt  time.Time
	lastProbe error

	failures atomic.Int64
	lastFail atomic.Pointer[writeFailure]
}

type writeFailure struct {
	at  time.Time
	err string
}

// Guard wraps store; pinger is normally the same PostgresStore. A nil pinger
// means Ready only reflects the fail-closed switch (never pings).
func Guard(store Store, pinger Pinger, failClosed bool) *Guarded {
	g := &Guarded{Store: store, pinger: pinger, failClosed: failClosed, ttl: 2 * time.Second}
	g.prober, _ = pinger.(WriteProber)
	return g
}

// Write persists through the inner Store, counting and logging failures. A
// failure also drops the Ready cache so the next check pings again.
func (g *Guarded) Write(ctx context.Context, rec Record) (int64, error) {
	id, err := g.Store.Write(ctx, rec)
	g.mu.Lock()
	if err != nil {
		g.checkedAt, g.probedAt = time.Time{}, time.Time{}
		g.broken = true
	} else {
		g.broken = false
	}
	g.mu.Unlock()
	if err != nil {
		g.failures.Add(1)
		g.lastFail.Store(&writeFailure{at: time.Now(), err: err.Error()})
		slog.ErrorContext(ctx, "audit: write failed", "action", rec.Action, "error", err)
	}
	return id, err
}

// Ready implements Readier.
func (g *Guarded) Ready(ctx context.Context) error {
	if !g.failClosed || g.pinger == nil {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Since(g.checkedAt) >= g.ttl {
		pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		g.lastPing = g.pinger.Ping(pctx)
		cancel()
		g.checkedAt = time.Now()
	}
	if g.lastPing != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, g.lastPing)
	}
	if g.broken && g.prober != nil {
		if time.Since(g.probedAt) >= g.ttl {
			pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			g.lastProbe = g.prober.ProbeWrite(pctx)
			cancel()
			g.probedAt = time.Now()
			g.broken = g.lastProbe != nil
		}
		if g.broken {
			return fmt.Errorf("%w: %v", ErrUnavailable, g.lastProbe)
		}
	}
	return nil
}

// FailClosed reports the switch the wrapper was built with.
func (g *Guarded) FailClosed() bool { return g.failClosed }

// Status implements Statuser.
func (g *Guarded) Status(ctx context.Context) Status {
	st := Status{Writer: "postgres", FailClosed: g.failClosed, WriteFailures: g.failures.Load()}
	if g.pinger != nil {
		pctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		st.Ready = g.pinger.Ping(pctx) == nil
		cancel()
	} else {
		st.Ready = true
	}
	if f := g.lastFail.Load(); f != nil {
		at := f.at
		st.LastError, st.LastErrorAt = f.err, &at
	}
	return st
}

// RequireWritable is middleware for the mutation routes: when the store is not
// ready, every request that is not GET/HEAD/OPTIONS (and not on a skip path)
// is answered 503 {"detail":"audit unavailable"} before the handler runs; the
// reason (which names the database host) goes to the log only. Audited GET
// paths (Secret reveal, logs, exec, kubeconfig) check Ready in their handlers
// instead, since only some of their calls are sensitive.
func RequireWritable(rd Readier, skipPaths ...string) func(http.Handler) http.Handler {
	skip := make(map[string]bool, len(skipPaths))
	for _, p := range skipPaths {
		skip[p] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
				next.ServeHTTP(w, r)
				return
			}
			if skip[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			if err := rd.Ready(r.Context()); err != nil {
				slog.WarnContext(r.Context(), "audit: refusing unrecorded action", "method", r.Method, "path", r.URL.Path, "error", err)
				response.Error(w, http.StatusServiceUnavailable, ErrUnavailable.Error())
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
