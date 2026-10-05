package auditsink

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Store is the database side of the dispatcher (postgres.go).
type Store interface {
	// EnsureCursor returns a sink's cursor, creating it at start if new.
	EnsureCursor(ctx context.Context, sink string, start int64) (int64, error)
	MaxID(ctx context.Context) (int64, error)
	// After returns up to limit rows with id > after that are older than settle.
	After(ctx context.Context, after int64, limit int, settle time.Duration) ([]Event, error)
	Advance(ctx context.Context, sink string, id int64) error
	Fail(ctx context.Context, sink, msg string) error
}

// Locker elects the one replica that sends. TryLock reports ok=false when
// another replica holds it; lost is closed if the lock goes away.
type Locker interface {
	TryLock(ctx context.Context) (release func(), lost <-chan struct{}, ok bool, err error)
}

const (
	readPage    = 500
	settleDelay = 5 * time.Second
	maxBackoff  = 5 * time.Minute
	sendTimeout = 60 * time.Second
	lockRetry   = 5 * time.Second // short: after a rollout the new pod takes over soon after the old one exits
)

type sinkRun struct {
	cfg       SinkConfig
	sink      Sink
	maxEvents int
	maxWait   time.Duration

	pending     atomic.Int64
	sent        atomic.Int64
	failures    atomic.Int64
	lastSuccess atomic.Int64 // unix seconds
}

// Dispatcher copies audit rows to the configured sinks.
type Dispatcher struct {
	sinks  []*sinkRun
	store  Store
	locker Locker
	leader atomic.Bool
	sleep  func(ctx context.Context, d time.Duration) bool
}

// New builds the sinks of cfg. With no sinks the dispatcher does nothing.
func New(cfg Config, store Store, locker Locker) (*Dispatcher, error) {
	d := &Dispatcher{store: store, locker: locker, sleep: sleepCtx}
	for _, sc := range cfg.Sinks {
		s, err := sc.build()
		if err != nil {
			return nil, err
		}
		maxEvents, maxWait := sc.batchLimits()
		d.sinks = append(d.sinks, &sinkRun{cfg: sc, sink: s, maxEvents: maxEvents, maxWait: time.Duration(maxWait) * time.Second})
	}
	return d, nil
}

// Names lists the configured sinks (retention keeps rows they have not sent).
func (d *Dispatcher) Names() []string {
	out := make([]string, 0, len(d.sinks))
	for _, s := range d.sinks {
		out = append(out, s.cfg.Name)
	}
	return out
}

// Run elects a leader and, while this replica holds the lock, runs one loop
// per sink. It returns when ctx ends.
func (d *Dispatcher) Run(ctx context.Context) {
	if len(d.sinks) == 0 {
		return
	}
	for ctx.Err() == nil {
		release, lost, ok, err := d.locker.TryLock(ctx)
		if err != nil {
			slog.Warn("audit sinks: leader lock", "err", err)
		}
		if !ok {
			if !d.sleep(ctx, lockRetry) {
				return
			}
			continue
		}
		slog.Info("audit sinks: this replica sends", "sinks", d.Names())
		d.leader.Store(true)
		runCtx, cancel := context.WithCancel(ctx)
		var wg sync.WaitGroup
		for _, s := range d.sinks {
			s.lastSuccess.Store(time.Now().Unix())
			wg.Add(1)
			go func(s *sinkRun) { defer wg.Done(); d.runSink(runCtx, s) }(s)
		}
		select {
		case <-ctx.Done():
		case <-lost:
			slog.Warn("audit sinks: leader lock lost; stopping until it is held again")
		}
		cancel()
		wg.Wait()
		d.leader.Store(false)
		release()
	}
}

func (d *Dispatcher) runSink(ctx context.Context, s *sinkRun) {
	log := slog.With("sink", s.cfg.Name, "type", s.cfg.Type)
	var start int64
	if !s.cfg.startAtBeginning() {
		max, err := d.store.MaxID(ctx)
		if err != nil {
			log.Warn("audit sink: read max id", "err", err)
		}
		start = max
	}
	cursor, err := d.store.EnsureCursor(ctx, s.cfg.Name, start)
	for err != nil {
		log.Warn("audit sink: cursor", "err", err)
		if !d.sleep(ctx, s.maxWait) {
			return
		}
		cursor, err = d.store.EnsureCursor(ctx, s.cfg.Name, start)
	}
	backoff := time.Duration(0)
	for ctx.Err() == nil {
		next, full, sendErr := d.step(ctx, s, cursor)
		cursor = next
		wait := s.maxWait
		switch {
		case sendErr != nil:
			if backoff == 0 {
				backoff = s.maxWait
			} else if backoff *= 2; backoff > maxBackoff {
				backoff = maxBackoff
			}
			wait = backoff
			log.Warn("audit sink: send failed; retrying", "err", sendErr, "retry_in", backoff.String(), "cursor", cursor)
		case full:
			backoff, wait = 0, 0
		default:
			backoff = 0
		}
		if wait > 0 && !d.sleep(ctx, wait) {
			return
		}
	}
}

// step reads one page past cursor, sends what the filter keeps in chunks of
// maxEvents and returns the new cursor: past the whole page when every chunk
// went out, or just before the first event of the chunk that failed.
func (d *Dispatcher) step(ctx context.Context, s *sinkRun, cursor int64) (next int64, full bool, sendErr error) {
	if max, err := d.store.MaxID(ctx); err == nil {
		s.pending.Store(max - cursor)
	}
	rows, err := d.store.After(ctx, cursor, readPage, settleDelay)
	if err != nil {
		return cursor, false, err
	}
	if len(rows) == 0 {
		return cursor, false, nil
	}
	matched := s.cfg.Filter.Apply(rows)
	for i := 0; i < len(matched); i += s.maxEvents {
		end := i + s.maxEvents
		if end > len(matched) {
			end = len(matched)
		}
		sctx, cancel := context.WithTimeout(ctx, sendTimeout)
		err := s.sink.Send(sctx, matched[i:end])
		cancel()
		if err != nil {
			s.failures.Add(1)
			_ = d.store.Fail(ctx, s.cfg.Name, err.Error())
			upTo := matched[i].ID - 1
			if upTo > cursor {
				if aerr := d.store.Advance(ctx, s.cfg.Name, upTo); aerr == nil {
					cursor = upTo
				}
			}
			return cursor, false, err
		}
		s.sent.Add(int64(end - i))
	}
	last := rows[len(rows)-1].ID
	if err := d.store.Advance(ctx, s.cfg.Name, last); err != nil {
		return cursor, false, err
	}
	s.lastSuccess.Store(time.Now().Unix())
	s.pending.Add(-(last - cursor))
	return last, len(rows) == readPage, nil
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

var (
	descPending  = prometheus.NewDesc("kubeast_audit_sink_pending", "Audit rows not yet handled by the sink (only the replica that sends reports it).", []string{"sink", "type"}, prometheus.Labels{"service": "auth"})
	descSent     = prometheus.NewDesc("kubeast_audit_sink_sent_events_total", "Audit events sent by the sink since this replica started sending.", []string{"sink", "type"}, prometheus.Labels{"service": "auth"})
	descFailures = prometheus.NewDesc("kubeast_audit_sink_failures_total", "Failed sends by the sink since this replica started sending.", []string{"sink", "type"}, prometheus.Labels{"service": "auth"})
	descLast     = prometheus.NewDesc("kubeast_audit_sink_last_success_timestamp_seconds", "When the sink last moved its cursor (or when this replica started sending).", []string{"sink", "type"}, prometheus.Labels{"service": "auth"})
)

// Collector exposes the sink metrics; a replica that does not hold the
// leader lock reports none, so alerts see only the sending replica.
func (d *Dispatcher) Collector() prometheus.Collector { return collector{d} }

type collector struct{ d *Dispatcher }

func (c collector) Describe(ch chan<- *prometheus.Desc) {
	ch <- descPending
	ch <- descSent
	ch <- descFailures
	ch <- descLast
}

func (c collector) Collect(ch chan<- prometheus.Metric) {
	if !c.d.leader.Load() {
		return
	}
	for _, s := range c.d.sinks {
		l := []string{s.cfg.Name, s.cfg.Type}
		ch <- prometheus.MustNewConstMetric(descPending, prometheus.GaugeValue, float64(s.pending.Load()), l...)
		ch <- prometheus.MustNewConstMetric(descSent, prometheus.CounterValue, float64(s.sent.Load()), l...)
		ch <- prometheus.MustNewConstMetric(descFailures, prometheus.CounterValue, float64(s.failures.Load()), l...)
		ch <- prometheus.MustNewConstMetric(descLast, prometheus.GaugeValue, float64(s.lastSuccess.Load()), l...)
	}
}
