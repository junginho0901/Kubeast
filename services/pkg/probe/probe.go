// Package probe answers the kubelet's probes and tells a service's long-lived connections that the server is leaving.
//
// /livez says the process answers and asks nothing else, so a database or another service that is down never
// restarts the pod. /readyz says the pod takes new requests: not from SIGTERM on (Leave), and not while a dependency
// the service cannot answer anything without is down (Require). A dependency only some routes need stays out of it:
// every replica shares it, so it would take them all out of the Service at once.
//
// Hold ties a long-lived connection (a WebSocket, an event stream) to the server: when Leave is called its context
// ends with ErrLeaving as the cause, so the connection says so to the browser, which connects again to a pod that
// stays. Wait waits for those connections to be released.
package probe

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// ErrLeaving is the cancel cause of a held context whose server started to leave.
var ErrLeaving = errors.New("server leaving")

// LeavingReason is the close reason a WebSocket ended by Leave carries, with close code 1012 (Service Restart).
const LeavingReason = "server_restarting"

// checkTimeout keeps a check inside the kubelet's default probe timeout of 1 s.
const checkTimeout = 800 * time.Millisecond

// Check says whether a dependency answers; ctx carries the time it has.
type Check func(ctx context.Context) error

type namedCheck struct {
	name  string
	check Check
}

// Probe holds a service's readiness: whether it is leaving and the dependencies it cannot answer without.
// A nil *Probe holds nothing: Hold returns the context as it is.
type Probe struct {
	leaving context.Context
	leave   context.CancelFunc
	checks  []namedCheck
	held    atomic.Int64
	// failing is what the last /readyz found missing, so a change is logged once and not on every probe.
	mu      sync.Mutex
	failing string
}

// New returns a Probe that is ready while every check passes and the server is not leaving.
func New() *Probe {
	ctx, cancel := context.WithCancel(context.Background())
	return &Probe{leaving: ctx, leave: cancel}
}

// Require adds a dependency the service cannot answer anything without. Call it before serving.
func (p *Probe) Require(name string, c Check) *Probe {
	p.checks = append(p.checks, namedCheck{name: name, check: c})
	return p
}

// Leave marks the server as leaving (SIGTERM): /readyz answers 503 from now on and every held context ends.
func (p *Probe) Leave() {
	if p == nil {
		return
	}
	slog.Info("leaving: not ready, ending held connections", "held", p.held.Load())
	p.leave()
}

// Leaving reports whether Leave was called.
func (p *Probe) Leaving() bool {
	return p != nil && p.leaving.Err() != nil
}

// Hold returns a context that ends with ErrLeaving as its cause when Leave is called, and the function to release it
// (call it when the connection ends). A context held after Leave ends at once.
func (p *Probe) Hold(ctx context.Context) (context.Context, func()) {
	if p == nil {
		return ctx, func() {}
	}
	held, cancel := context.WithCancelCause(ctx)
	p.held.Add(1)
	stop := context.AfterFunc(p.leaving, func() { cancel(ErrLeaving) })
	var once sync.Once
	return held, func() {
		once.Do(func() {
			stop()
			cancel(nil)
			p.held.Add(-1)
		})
	}
}

// Held is the number of contexts held and not released.
func (p *Probe) Held() int64 {
	if p == nil {
		return 0
	}
	return p.held.Load()
}

// Wait waits until every held context is released or ctx ends, and reports whether they all were.
func (p *Probe) Wait(ctx context.Context) bool {
	if p == nil {
		return true
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for p.held.Load() > 0 {
		select {
		case <-ctx.Done():
			slog.Warn("leaving: connections still open at the end of the wait", "held", p.held.Load())
			return false
		case <-tick.C:
		}
	}
	return true
}

// IsLeaving reports whether ctx ended because its server is leaving.
func IsLeaving(ctx context.Context) bool {
	return errors.Is(context.Cause(ctx), ErrLeaving)
}

// Live answers the liveness probe: the process answers. It reads nothing else.
func (p *Probe) Live(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// Ready answers the readiness probe: 503 while leaving or while a required dependency does not answer. The body names
// what is missing, never the error, which may hold an address.
func (p *Probe) Ready(w http.ResponseWriter, r *http.Request) {
	if p.Leaving() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "leaving"})
		return
	}
	var missing []string
	var firstErr error
	for _, c := range p.checks {
		ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
		err := c.check(ctx)
		cancel()
		if err != nil {
			missing = append(missing, c.name)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	p.noteChange(missing, firstErr)
	if len(missing) > 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not ready", "waiting_for": missing})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready"})
}

func (p *Probe) noteChange(missing []string, err error) {
	now := ""
	for i, m := range missing {
		if i > 0 {
			now += ","
		}
		now += m
	}
	p.mu.Lock()
	before := p.failing
	p.failing = now
	p.mu.Unlock()
	switch {
	case now == before:
	case now == "":
		slog.Info("ready: required dependencies answer again", "were_missing", before)
	default:
		slog.Warn("not ready: a required dependency does not answer", "missing", now, "error", err)
	}
}

// Pinger is a connection pool's Ping (*pgxpool.Pool).
type Pinger interface {
	Ping(ctx context.Context) error
}

// Database checks the service's database through its own pool. busy says whether every connection of the pool is
// taken: a ping that runs out of time then waited for a connection, which is load the database is answering, not a
// database gone, and would take every busy replica out at once.
func Database(db Pinger, busy func() bool) Check {
	return func(ctx context.Context) error {
		err := db.Ping(ctx)
		if err != nil && ctx.Err() != nil && busy != nil && busy() {
			return nil
		}
		return err
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
