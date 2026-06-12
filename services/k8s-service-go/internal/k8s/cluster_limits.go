package k8s

import (
	"sync"

	"golang.org/x/time/rate"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// clusterLimiters holds a token-bucket rate limiter per cluster (step 15) so a
// burst of requests to one cluster can't starve the others. qps<=0 disables
// limiting entirely. The per-cluster circuit breaker lives in clusterHealth.
type clusterLimiters struct {
	qps   int
	burst int
	mu    sync.Mutex
	m     map[cluster.ID]*rate.Limiter
}

func newClusterLimiters(qps, burst int) *clusterLimiters {
	return &clusterLimiters{qps: qps, burst: burst, m: map[cluster.ID]*rate.Limiter{}}
}

// Allow reports whether a request to id may proceed under its rate limit.
func (l *clusterLimiters) Allow(id cluster.ID) bool {
	if l == nil || l.qps <= 0 {
		return true
	}
	l.mu.Lock()
	lim, ok := l.m[id]
	if !ok {
		b := l.burst
		if b < l.qps {
			b = l.qps
		}
		lim = rate.NewLimiter(rate.Limit(l.qps), b)
		l.m[id] = lim
	}
	l.mu.Unlock()
	return lim.Allow()
}
