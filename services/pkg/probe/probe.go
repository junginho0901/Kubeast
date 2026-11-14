// Package probe answers the kubelet's probes and tells a service's long-lived connections that the server is leaving.
//
// /livez says the process answers and asks nothing else, so a database or another service that is down never
// restarts the pod. /readyz says the pod takes new requests: from the moment it serves until SIGTERM (Leave). No
// dependency is asked: every replica shares the database, and a check of it would take them all out of the Service at
// once, turning the services' own 503 answers into refused connections. The database's state is read elsewhere
// (/health, the audit store metrics).
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

// LeavingReason is the close reason of a WebSocket ended by Leave (close code 1012, Service Restart) and the reason of
// the k8s.session.end row of a terminal it ended.
const LeavingReason = "server_leaving"

// Probe holds a service's readiness: whether it is leaving. A nil *Probe holds nothing: Hold returns the context as
// it is.
type Probe struct {
	leaving context.Context
	leave   context.CancelFunc
	held    atomic.Int64
}

// New returns a Probe that is ready until Leave.
func New() *Probe {
	ctx, cancel := context.WithCancel(context.Background())
	return &Probe{leaving: ctx, leave: cancel}
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

// Ready answers the readiness probe: 200 while the server serves, 503 from Leave on.
func (p *Probe) Ready(w http.ResponseWriter, _ *http.Request) {
	if p.Leaving() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "leaving"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
