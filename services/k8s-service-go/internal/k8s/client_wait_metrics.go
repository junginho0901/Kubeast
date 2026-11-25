package k8s

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"k8s.io/client-go/util/flowcontrol"
)

// The rate limiters of each cluster's clients: the turnLimiter of every request (userCfg) and, with
// multicluster.reviewQPS, one for the access checks; client-go's token bucket of kubeast:cache (cachedRate). The
// dynamic client keeps client-go's own rate, not counted.
const (
	limiterUser   = "user"
	limiterReview = "review"
	limiterCache  = "cache"
)

// The places a kind of read takes, on each cluster (clusterPlaces) or in k8s-service for every cluster (bigReadSlots),
// as the place wait histogram names them.
const (
	placesNodePods  = "node_pods"
	placesEventList = "event_list"
	placesBigRead   = "big_read"
)

// clientWaitBuckets reach past passOverLimit to a request's 60 s.
var clientWaitBuckets = []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60}

// clientWaitMetrics are how long requests to the clusters waited for the client's rate, by limiter and whether a check asked again let later requests go first, and for a place of their kind of read, by places; summed over clusters, never by cluster, user or route.
type clientWaitMetrics struct {
	seconds *prometheus.HistogramVec
	waits   *prometheus.CounterVec
	places  *prometheus.HistogramVec
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
		places: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "kubeast_k8s_read_place_wait_seconds", Help: "Seconds a read of a cluster waited for one of the places for its kind of read, that cluster's or, for big_read, k8s-service's (a few microseconds when one was free), by places.",
			ConstLabels: svc, Buckets: clientWaitBuckets,
		}, []string{"places"}),
	}
}

// clientWait is what the limiters of k8s-service's clients count into.
var clientWait = newClientWaitMetrics()

// ClientWaitCollectors are the client wait metrics, for the service's registry.
func ClientWaitCollectors() []prometheus.Collector { return clientWait.collectors() }

func (m *clientWaitMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{m.seconds, m.waits, m.places}
}

// forPlaces is the series of one kind of read's places.
func (m *clientWaitMetrics) forPlaces(places string) prometheus.Observer {
	return m.places.WithLabelValues(places)
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

// cacheWaits are the kubeast:cache limiter's series: no access check is asked on that client, so it has no
// passed_over="true".
type cacheWaits struct {
	inTurn prometheus.Observer
	waited prometheus.Counter
}

func (m *clientWaitMetrics) forCache() cacheWaits {
	return cacheWaits{inTurn: m.seconds.WithLabelValues(limiterCache, "false"), waited: m.waits.WithLabelValues(limiterCache)}
}

// cachedRate is client-go's token bucket of the kubeast:cache client, the same rate and burst as before, its waits
// observed as the turnLimiter's are: 0 for a request that took a token at once, else the time it waited, counted as a
// wait whether it got the token or its context ended first.
type cachedRate struct {
	flowcontrol.RateLimiter
	waits cacheWaits
}

func newCachedRate(qps float32, burst int, waits cacheWaits) cachedRate {
	return cachedRate{RateLimiter: flowcontrol.NewTokenBucketRateLimiter(qps, burst), waits: waits}
}

func (l cachedRate) Wait(ctx context.Context) error {
	if l.RateLimiter.TryAccept() {
		l.waits.inTurn.Observe(0)
		return nil
	}
	start := time.Now()
	err := l.RateLimiter.Wait(ctx)
	l.waits.waited.Inc()
	l.waits.inTurn.Observe(time.Since(start).Seconds())
	return err
}
