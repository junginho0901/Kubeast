package k8s

import (
	"context"
	"sync"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// clusterPlaces are n places for one kind of read on each cluster, made when that cluster is first read.
type clusterPlaces struct {
	name string
	n    int
	mu   sync.Mutex
	of   map[cluster.ID]*limits.Slots
}

func newClusterPlaces(name string, n int) *clusterPlaces {
	return &clusterPlaces{name: name, n: n, of: map[cluster.ID]*limits.Slots{}}
}

// take waits for one of id's places until ctx ends and returns the function that gives it back.
func (c *clusterPlaces) take(ctx context.Context, id cluster.ID) (func(), error) {
	c.mu.Lock()
	places := c.of[id]
	if places == nil {
		places = limits.NewSlots(c.name+" on "+string(id), c.n)
		c.of[id] = places
	}
	c.mu.Unlock()
	return places.Take(ctx)
}
