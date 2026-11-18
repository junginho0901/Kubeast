package k8s

import "github.com/prometheus/client_golang/prometheus"

// accessReviewMetrics count the reviews the remembered access checks send (mayDo, askAsGroups) by whom they are asked
// as; summed over clusters, never by cluster, user or route.
type accessReviewMetrics struct {
	sent               *prometheus.CounterVec
	asPerson, byGroups prometheus.Counter
}

func newAccessReviewMetrics() *accessReviewMetrics {
	sent := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name:        "kubeast_k8s_access_reviews_total",
		Help:        "SelfSubjectAccessReviews the remembered access checks sent to a cluster, by whom they were asked as: the person, or the groups of the people an allowed read check is shared by.",
		ConstLabels: prometheus.Labels{"service": "k8s"},
	}, []string{"asked_as"})
	return &accessReviewMetrics{sent: sent, asPerson: sent.WithLabelValues("person"), byGroups: sent.WithLabelValues("groups")}
}

var accessReviews = newAccessReviewMetrics()

// AccessReviewCollectors are the access review counts, for the service's registry.
func AccessReviewCollectors() []prometheus.Collector {
	return []prometheus.Collector{accessReviews.sent}
}
