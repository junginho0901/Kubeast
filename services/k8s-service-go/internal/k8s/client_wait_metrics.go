package k8s

import "github.com/prometheus/client_golang/prometheus"

// The turnLimiter of each cluster's clients: one for every request (userCfg) and, with multicluster.reviewQPS, one for the access checks.
const (
	limiterUser   = "user"
	limiterReview = "review"
)

// clientWaitBuckets reach past passOverLimit to a request's 60 s.
var clientWaitBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60}

// clientWaitMetrics are how long requests to the clusters waited for the client's rate, by limiter and whether a check asked again let later requests go first; summed over clusters, never by cluster, user or route.
type clientWaitMetrics struct {
	seconds *prometheus.HistogramVec
	waits   *prometheus.CounterVec
}

func newClientWaitMetrics() *clientWaitMetrics {
	svc := prometheus.Labels{"service": "k8s"}
	return &clientWaitMetrics{
		seconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "kubeast_k8s_client_rate_wait_seconds", Help: "Seconds a request to a cluster waited for the client's rate (0 when it went at once), by limiter and whether a check asked again let later requests go first.",
			ConstLabels: svc, Buckets: clientWaitBuckets,
		}, []string{"limiter", "passed_over"}),
		waits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "kubeast_k8s_client_rate_waits_total", Help: "Requests to a cluster that waited for the client's rate, given a token or not, by limiter.", ConstLabels: svc,
		}, []string{"limiter"}),
	}
}

// clientWait is what the limiters of k8s-service's clients count into.
var clientWait = newClientWaitMetrics()

// ClientWaitCollectors are the client wait metrics, for the service's registry.
func ClientWaitCollectors() []prometheus.Collector { return clientWait.collectors() }

func (m *clientWaitMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{m.seconds, m.waits}
}

// turnWaits are one limiter's series, looked up once so that a request only observes.
type turnWaits struct {
	inTurn     prometheus.Observer
	passedOver prometheus.Observer
	waited     prometheus.Counter
}

func (m *clientWaitMetrics) forLimiter(limiter string) turnWaits {
	return turnWaits{
		inTurn:     m.seconds.WithLabelValues(limiter, "false"),
		passedOver: m.seconds.WithLabelValues(limiter, "true"),
		waited:     m.waits.WithLabelValues(limiter),
	}
}
