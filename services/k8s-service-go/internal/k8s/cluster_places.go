package k8s

import (
	"context"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// clusterPlaces are n places for one kind of read on each cluster, made when that cluster is first read.
type clusterPlaces struct {
	name string
	n    int
	// waited times each take, summed over clusters (kubeast_k8s_read_place_wait_seconds)
	waited prometheus.Observer
	mu     sync.Mutex
	of     map[cluster.ID]*limits.Slots
}

func newClusterPlaces(name string, n int, waited prometheus.Observer) *clusterPlaces {
	return &clusterPlaces{name: name, n: n, waited: waited, of: map[cluster.ID]*limits.Slots{}}
}

// take waits for one of id's places until ctx ends and returns the function that gives it back; the wait is
// observed whether it got a place or its context ended first.
func (c *clusterPlaces) take(ctx context.Context, id cluster.ID) (func(), error) {
	c.mu.Lock()
	places := c.of[id]
	if places == nil {
		places = limits.NewSlots(c.name+" on "+string(id), c.n)
		c.of[id] = places
	}
	c.mu.Unlock()
	start := time.Now()
	release, err := places.Take(ctx)
	c.waited.Observe(time.Since(start).Seconds())
	return release, err
}
