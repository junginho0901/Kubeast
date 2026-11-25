package k8s

import (
	"context"
	"sync/atomic"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// clusterShare gives out the places of all, one number for every cluster together. While more than one cluster is
// registered one of them takes at most half, rounded up: a read keeps its place while it waits for its cluster, and one
// cluster slow to answer its lists held them all, so the other clusters' reads waited for it. The only cluster takes
// them all. None is lent past the half: a place comes back when its read ends, not when another cluster asks.
type clusterShare struct {
	all     *limits.Slots
	own     *clusterSlots
	several atomic.Bool
}

func newClusterShare(name string, all *limits.Slots) *clusterShare {
	return &clusterShare{all: all, own: newClusterSlots(name, (all.Cap()+1)/2)}
}

// registered says how many clusters there are.
func (c *clusterShare) registered(n int) { c.several.Store(n > 1) }

// take waits until ctx ends for a place of id's half and then for one of all, and returns the function that gives both
// back. In that order a cluster's reads past its half wait for their own and stand in no other cluster's way.
func (c *clusterShare) take(ctx context.Context, id cluster.ID) (func(), error) {
	if !c.several.Load() {
		return c.all.Take(ctx)
	}
	giveOwn, err := c.own.on(id).Take(ctx)
	if err != nil {
		return nil, err
	}
	give, err := c.all.Take(ctx)
	if err != nil {
		giveOwn()
		return nil, err
	}
	return func() {
		give()
		giveOwn()
	}, nil
}

// Registered says how many clusters the registry holds, at each read of it (internal/clustersync): bigReadShare goes by it.
func (s *Service) Registered(clusters int) { bigReadShare.registered(clusters) }

// clusterOf is the cluster ctx's read is of: the one ctx targets, else the one of the request the read is made for,
// which a read once for everyone carries without the rest of the request (carryClusterCalls).
func clusterOf(ctx context.Context) cluster.ID {
	if id, ok := cluster.FromContext(ctx); ok && id != "" {
		return id
	}
	if calls, ok := ctx.Value(clusterCallsKey{}).(*ClusterCalls); ok {
		return calls.id
	}
	return ctxClusterID(ctx)
}
