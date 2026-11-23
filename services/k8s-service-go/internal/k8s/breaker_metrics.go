package k8s

import "github.com/prometheus/client_golang/prometheus"

// What opened a cluster's breaker: requests that could not reach the cluster, threshold of them in a row, or a health
// check's probe.
const (
	breakerOpenedByRequests    = "requests"
	breakerOpenedByHealthCheck = "health_check"
)

// breakerMetrics are the clusters' breakers summed over clusters, never by cluster, user or route.
type breakerMetrics struct {
	opens    *prometheus.CounterVec
	refusals prometheus.Counter
}

func newBreakerMetrics() *breakerMetrics {
	svc := prometheus.Labels{"service": "k8s"}
	m := &breakerMetrics{
		opens: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kubeast_k8s_cluster_breaker_opens_total", Help: "Times a cluster's breaker went from closed to open, by what opened it (requests, health_check).", ConstLabels: svc,
		}, []string{"by"}),
		refusals: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "kubeast_k8s_cluster_breaker_refusals_total", Help: "Requests to a cluster answered 503 at once because its breaker was open.", ConstLabels: svc,
		}),
	}
	m.opens.WithLabelValues(breakerOpenedByRequests)
	m.opens.WithLabelValues(breakerOpenedByHealthCheck)
	return m
}

// breakerCounts is what the breakers of k8s-service's clusters count into.
var breakerCounts = newBreakerMetrics()

func (m *breakerMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{m.opens, m.refusals}
}

// BreakerCollectors are the breaker metrics, with the number of clusters whose breaker s holds open, for the service's
// registry.
func BreakerCollectors(s *Service) []prometheus.Collector {
	return append(breakerCounts.collectors(), openBreakersGauge(s))
}

func openBreakersGauge(s *Service) prometheus.Collector {
	return prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "kubeast_k8s_cluster_breakers_open", Help: "Clusters whose breaker is open now (their requests are answered 503 at once but for one trial per period).",
		ConstLabels: prometheus.Labels{"service": "k8s"},
	}, func() float64 { return float64(s.OpenBreakers()) })
}

// OpenBreakers is how many clusters have an open breaker; 0 with the breaker off. nil-safe.
func (s *Service) OpenBreakers() int {
	if s == nil || s.health == nil {
		return 0
	}
	return s.health.openCount()
}
