package k8s

import (
	"context"
	"sync"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/limits"
)

// podRowLists are the places of the callers that list the pod rows as themselves (callerPodRows until the informers
// serve), taken before the first page and kept until the answer is made. They are not podRowSlots: a caller listing
// waits for its cluster, and with the same places one cluster slow to answer its lists held them all, so the callers
// the informers answer waited too, on every cluster.
var podRowLists = newPodListPlaces(cap(podRowSlots))

// podListPlaces are places for the lists of every cluster together, at most half of them, rounded up, one cluster's.
type podListPlaces struct {
	all  *limits.Slots
	each int
	mu   sync.Mutex
	of   map[cluster.ID]*limits.Slots
}

func newPodListPlaces(rowPlaces int) *podListPlaces {
	n := podListsAtOnce(rowPlaces)
	return &podListPlaces{all: limits.NewSlots("pod row list", n), each: (n + 1) / 2, of: map[cluster.ID]*limits.Slots{}}
}

// podListsAtOnce is how many callers may list beside rowPlaces callers holding the informers' rows. One listing holds
// rows of its own, about 20 MB on 50 000 pods, as much as ten of the others (2 MB each): with one place fewer than
// rowPlaces all of them together hold no more than rowPlaces lists, which is what the places held when they were one
// kind for both (TestPodListsAndRowPlacesHoldNoMoreThanRowPlacesLists). Two CPUs still get two, so two clusters can
// list at once, for about 4 MB more.
func podListsAtOnce(rowPlaces int) int {
	return min(rowPlaces, max(2, rowPlaces-1))
}

// take waits for one of id's places and then one of all, until ctx ends, and returns the function that gives both back.
// In that order at most each of those waiting for the second are one cluster's.
func (p *podListPlaces) take(ctx context.Context, id cluster.ID) (func(), error) {
	p.mu.Lock()
	own := p.of[id]
	if own == nil {
		own = limits.NewSlots("pod row list on "+string(id), p.each)
		p.of[id] = own
	}
	p.mu.Unlock()
	giveOwn, err := own.Take(ctx)
	if err != nil {
		return nil, err
	}
	give, err := p.all.Take(ctx)
	if err != nil {
		giveOwn()
		return nil, err
	}
	return func() {
		give()
		giveOwn()
	}, nil
}
