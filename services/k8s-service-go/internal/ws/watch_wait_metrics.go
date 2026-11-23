package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// The places a watch waits for before it starts: start is one of its cluster's places for starting a watch
// (MaxWatchStarts: takeWatchStart, StartWatch), opening one of the server's places for the objects a watch from no
// version opens with (MaxWatchOpenings: takeOpening).
const (
	placesStart   = "start"
	placesOpening = "opening"
)

// watchWaitBuckets reach from a free place (microseconds) to a stream's wait of a minute.
var watchWaitBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60}

// memoryWaitLogEvery bounds the log line that says new watches wait for memory: a crowd's screens ask again together.
const memoryWaitLogEvery = 10 * time.Second

// watchWaitMetrics are the waits of the watches before they start, summed over clusters and sockets, never by cluster,
// user or route.
type watchWaitMetrics struct {
	seconds *prometheus.HistogramVec
	waiting *prometheus.GaugeVec
	memory  prometheus.Counter

	// told is how many watches were told to wait for memory since the last log line, nextLog when the next may be
	// written (unix nanoseconds).
	told, nextLog atomic.Int64
}

func newWatchWaitMetrics() *watchWaitMetrics {
	svc := prometheus.Labels{"service": "k8s"}
	m := &watchWaitMetrics{
		seconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "kubeast_ws_watch_place_wait_seconds", Help: "Seconds a watch waited for one of its places before it started (a few microseconds when one was free), by places (start, opening).",
			ConstLabels: svc, Buckets: watchWaitBuckets,
		}, []string{"places"}),
		waiting: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "kubeast_ws_watches_waiting_for_place", Help: "Watches waiting for one of their places now, by places (start, opening).", ConstLabels: svc,
		}, []string{"places"}),
		memory: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "kubeast_ws_watch_memory_waits_total", Help: "New watches told to wait because k8s-service was short of memory (the limit frame of limit_scope memory).", ConstLabels: svc,
		}),
	}
	for _, places := range []string{placesStart, placesOpening} {
		m.seconds.WithLabelValues(places)
		m.waiting.WithLabelValues(places)
	}
	return m
}

// watchWaits is what the multiplexers count into.
var watchWaits = newWatchWaitMetrics()

// WatchWaitCollectors are the watches' wait metrics, for the service's registry.
func WatchWaitCollectors() []prometheus.Collector { return watchWaits.collectors() }

func (w *watchWaitMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{w.seconds, w.waiting, w.memory}
}

func (m *Multiplexer) waitMetrics() *watchWaitMetrics {
	if m.waits != nil {
		return m.waits
	}
	return watchWaits
}

// timedPlaces is a placeTaker whose takes are observed under places, a take that stopped waiting too.
type timedPlaces struct {
	placeTaker
	seconds prometheus.Observer
	waiting prometheus.Gauge
}

func (m *Multiplexer) timed(places string, p placeTaker) timedPlaces {
	w := m.waitMetrics()
	return timedPlaces{placeTaker: p, seconds: w.seconds.WithLabelValues(places), waiting: w.waiting.WithLabelValues(places)}
}

func (p timedPlaces) Take(ctx context.Context) (func(), error) {
	p.waiting.Inc()
	start := time.Now()
	give, err := p.placeTaker.Take(ctx)
	p.seconds.Observe(time.Since(start).Seconds())
	p.waiting.Dec()
	return give, err
}

// toldMemoryShort counts a new watch told to wait for memory and says so in the log, at most once per
// memoryWaitLogEvery with how many were told since the last line.
func (m *Multiplexer) toldMemoryShort() {
	w := m.waitMetrics()
	w.memory.Inc()
	w.told.Add(1)
	now := time.Now().UnixNano()
	next := w.nextLog.Load()
	if now < next || !w.nextLog.CompareAndSwap(next, now+int64(memoryWaitLogEvery)) {
		return
	}
	held, limit := m.heldAndLimit()
	slog.Warn("new watches wait: k8s-service is short of memory", "watches", w.told.Swap(0),
		"held_mib", held>>20, "limit_mib", limit>>20, "share", watchMemoryShare)
}
