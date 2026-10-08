package auditchain

import "github.com/prometheus/client_golang/prometheus"

var (
	descSealed   = prometheus.NewDesc("kubeast_audit_chain_sealed_seq", "Position of the last sealed audit row (0 = nothing sealed yet).", nil, prometheus.Labels{"service": "auth"})
	descUnsealed = prometheus.NewDesc("kubeast_audit_chain_unsealed_rows", "Audit rows not sealed yet, as of the last sealing run.", nil, prometheus.Labels{"service": "auth"})
	descAnchor   = prometheus.NewDesc("kubeast_audit_anchor_last_timestamp_seconds", "When a digest was last written to the anchor sink (0 = never, or anchoring off).", nil, prometheus.Labels{"service": "auth"})
)

// Collector exposes the sealer and anchorer gauges (anchorer may be nil).
func Collector(s *Sealer, a *Anchorer) prometheus.Collector { return collector{s, a} }

type collector struct {
	s *Sealer
	a *Anchorer
}

func (c collector) Describe(ch chan<- *prometheus.Desc) {
	ch <- descSealed
	ch <- descUnsealed
	ch <- descAnchor
}

func (c collector) Collect(ch chan<- prometheus.Metric) {
	if c.s != nil {
		ch <- prometheus.MustNewConstMetric(descSealed, prometheus.GaugeValue, float64(c.s.sealedSeq.Load()))
		ch <- prometheus.MustNewConstMetric(descUnsealed, prometheus.GaugeValue, float64(c.s.unsealed.Load()))
	}
	var last int64
	if c.a != nil {
		last = c.a.LastAt()
	}
	ch <- prometheus.MustNewConstMetric(descAnchor, prometheus.GaugeValue, float64(last))
}
