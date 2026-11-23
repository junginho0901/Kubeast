package drains

import "github.com/prometheus/client_golang/prometheus"

// endCounts are the drains whose end this process wrote, by status, never by cluster, node or user.
type endCounts struct {
	ended *prometheus.CounterVec
}

func newEndCounts() *endCounts {
	c := &endCounts{ended: prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "kubeast_k8s_node_drains_ended_total", Help: "Node drains whose end this replica wrote, by status (success, error, interrupted): its own drains, and the drains of a server gone that it marked interrupted.",
		ConstLabels: prometheus.Labels{"service": "k8s"},
	}, []string{"status"})}
	for _, s := range []string{StatusSuccess, StatusError, StatusInterrupted} {
		c.ended.WithLabelValues(s)
	}
	return c
}

// drainEnds is what the trackers count into.
var drainEnds = newEndCounts()

// Collectors are t's metrics for the service's registry: the drains it runs, whether they hold their evictions for a
// heartbeat not saved, and the drains whose end it wrote.
func Collectors(t *Tracker) []prometheus.Collector {
	svc := prometheus.Labels{"service": "k8s"}
	return []prometheus.Collector{
		t.ends.ended,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "kubeast_k8s_node_drains_running", Help: "Node drains this replica runs now.", ConstLabels: svc,
		}, func() float64 { return float64(t.Running()) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "kubeast_k8s_node_drains_holding", Help: "1 while this replica's drains hold their evictions: no heartbeat of theirs has been saved for 15 s.", ConstLabels: svc,
		}, func() float64 {
			if t.Holding() {
				return 1
			}
			return 0
		}),
	}
}

// Running is how many drains this process runs.
func (t *Tracker) Running() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.active)
}

// Holding says whether this process's drains hold their evictions now (Ready waits): it runs some and has saved no
// heartbeat for holdAfter.
func (t *Tracker) Holding() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.active) > 0 && t.now().Sub(t.beatAt) >= t.holdAfter
}
