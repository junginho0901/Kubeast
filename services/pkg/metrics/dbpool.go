package metrics

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// PoolStat is what a database pool says of itself; pgxpool's *Stat has these methods.
type PoolStat interface {
	AcquiredConns() int32
	IdleConns() int32
	ConstructingConns() int32
	MaxConns() int32
	EmptyAcquireCount() int64
	EmptyAcquireWaitTime() time.Duration
	CanceledAcquireCount() int64
}

// DBPool exposes the service's database pool, read once per scrape (stat, e.g. pgxpool's Stat): its connections in
// use, idle and being opened, the most it may hold, and the takes that found no idle connection or gave up waiting.
func (m *Metrics) DBPool(stat func() PoolStat) {
	m.Registry.MustRegister(newPoolCollector(m.Service, stat))
}

type poolCollector struct {
	stat                                   func() PoolStat
	conns, max, empty, emptyWait, canceled *prometheus.Desc
}

func newPoolCollector(service string, stat func() PoolStat) *poolCollector {
	svc := prometheus.Labels{"service": service}
	return &poolCollector{
		stat:      stat,
		conns:     prometheus.NewDesc("kubeast_db_pool_connections", "Database connections of the service's pool, by state (in_use, idle, opening).", []string{"state"}, svc),
		max:       prometheus.NewDesc("kubeast_db_pool_max_connections", "The most connections the service's pool may hold (postgresql.pool.<service>.maxConns).", nil, svc),
		empty:     prometheus.NewDesc("kubeast_db_pool_empty_acquires_total", "Takes of a connection that found none idle and waited for one to come back or be opened.", nil, svc),
		emptyWait: prometheus.NewDesc("kubeast_db_pool_empty_acquire_wait_seconds_total", "Seconds the takes that found no idle connection waited, summed.", nil, svc),
		canceled:  prometheus.NewDesc("kubeast_db_pool_canceled_acquires_total", "Takes of a connection whose context ended before one came.", nil, svc),
	}
}

func (c *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.conns, c.max, c.empty, c.emptyWait, c.canceled} {
		ch <- d
	}
}

func (c *poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.stat()
	ch <- prometheus.MustNewConstMetric(c.conns, prometheus.GaugeValue, float64(s.AcquiredConns()), "in_use")
	ch <- prometheus.MustNewConstMetric(c.conns, prometheus.GaugeValue, float64(s.IdleConns()), "idle")
	ch <- prometheus.MustNewConstMetric(c.conns, prometheus.GaugeValue, float64(s.ConstructingConns()), "opening")
	ch <- prometheus.MustNewConstMetric(c.max, prometheus.GaugeValue, float64(s.MaxConns()))
	ch <- prometheus.MustNewConstMetric(c.empty, prometheus.CounterValue, float64(s.EmptyAcquireCount()))
	ch <- prometheus.MustNewConstMetric(c.emptyWait, prometheus.CounterValue, s.EmptyAcquireWaitTime().Seconds())
	ch <- prometheus.MustNewConstMetric(c.canceled, prometheus.CounterValue, float64(s.CanceledAcquireCount()))
}
