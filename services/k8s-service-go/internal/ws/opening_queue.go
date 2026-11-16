package ws

import (
	"context"
	"sync"
)

// openingQueue is the server's places for the objects watches from no version open with, one set for every cluster
// since the memory they take is the process's (watchMemoryShare). A cluster takes them as follows:
//   - up to its own limit, which starts at one, goes up by one for each start its API server answered in time and
//     down by half for each one it did not (answered, timedOut), so a cluster that does not answer holds one place,
//     and a slow start among answered ones costs half of the limit, which the next answers bring back;
//   - up to half of the places while a cluster under its own limit waits for one;
//   - and every free place up to its limit otherwise (lent), so a server with one cluster opens as many lists at once
//     as it has places.
//
// The waiting clusters take turns: a cluster that got a place goes to the back of the line.
type openingQueue struct {
	mu      sync.Mutex
	size    int
	used    int
	held    map[string]int
	waiting map[string][]*openingWaiter
	order   []string       // clusters with waiters, the next one to be served first
	limits  map[string]int // a cluster's limit past one
}

type openingWaiter struct {
	cluster string
	granted bool
	lent    bool // granted past half while no other cluster waited
	ready   chan struct{}
}

func newOpeningQueue(size int) *openingQueue {
	return &openingQueue{size: max(1, size), held: map[string]int{}, waiting: map[string][]*openingWaiter{}, limits: map[string]int{}}
}

// Cap is the number of places.
func (q *openingQueue) Cap() int { return q.size }

// InUse is how many places are taken now.
func (q *openingQueue) InUse() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.used
}

// heldBy is how many places cluster holds now.
func (q *openingQueue) heldBy(cluster string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.held[cluster]
}

// waiters is how many watches wait for a place now.
func (q *openingQueue) waiters() (n int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, ws := range q.waiting {
		n += len(ws)
	}
	return n
}

// placesFor takes cluster's places in the queue as takeTurn takes places; lent says the place it took was lent.
func (q *openingQueue) placesFor(cluster string) *queuePlace {
	return &queuePlace{q: q, cluster: cluster}
}

type queuePlace struct {
	q       *openingQueue
	cluster string
	lent    bool
}

func (p *queuePlace) Take(ctx context.Context) (func(), error) {
	give, lent, err := p.q.takeLent(ctx, p.cluster)
	p.lent = lent
	return give, err
}

// take waits for one of the places for cluster until ctx ends and returns the function that gives it back.
func (q *openingQueue) take(ctx context.Context, cluster string) (func(), error) {
	give, _, err := q.takeLent(ctx, cluster)
	return give, err
}

// takeLent is take, saying whether the place was lent.
func (q *openingQueue) takeLent(ctx context.Context, cluster string) (func(), bool, error) {
	w := &openingWaiter{cluster: cluster, ready: make(chan struct{})}
	q.mu.Lock()
	if len(q.waiting[cluster]) == 0 {
		q.order = append(q.order, cluster)
	}
	q.waiting[cluster] = append(q.waiting[cluster], w)
	q.grant()
	q.mu.Unlock()
	select {
	case <-w.ready:
		return sync.OnceFunc(func() { q.give(cluster) }), w.lent, nil
	case <-ctx.Done():
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if w.granted {
		q.release(cluster)
	} else {
		q.drop(w, false)
		q.grant()
	}
	return nil, false, ctx.Err()
}

func (q *openingQueue) give(cluster string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.release(cluster)
}

func (q *openingQueue) release(cluster string) {
	q.used--
	q.held[cluster]--
	if q.held[cluster] == 0 {
		delete(q.held, cluster)
	}
	q.grant()
}

// answered notes a start of cluster its API server answered in time: its limit goes up by one.
func (q *openingQueue) answered(cluster string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n := q.limitOf(cluster); n < q.size {
		q.limits[cluster] = n + 1
		q.grant()
	}
}

// timedOut notes a start of cluster its API server did not answer in time, or answered with a 5xx: its limit halves.
func (q *openingQueue) timedOut(cluster string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n := q.limitOf(cluster) / 2; n > 1 {
		q.limits[cluster] = n
	} else {
		delete(q.limits, cluster)
	}
}

// limitOf is how many places cluster may hold, at most.
func (q *openingQueue) limitOf(cluster string) int {
	if n, ok := q.limits[cluster]; ok {
		return n
	}
	return 1
}

// grant gives the free places to the waiters, in turn: first the clusters under their limit and half of the places,
// then, when none of those waits, the clusters under their limit past half (lent).
func (q *openingQueue) grant() {
	half := max(1, q.size/2)
	for q.used < q.size {
		next, lent := "", false
		for _, c := range q.order {
			if q.held[c] < min(q.limitOf(c), half) {
				next = c
				break
			}
		}
		if next == "" {
			for _, c := range q.order {
				if q.held[c] < q.limitOf(c) {
					next, lent = c, true
					break
				}
			}
		}
		if next == "" {
			return
		}
		w := q.waiting[next][0]
		q.drop(w, true)
		w.granted, w.lent = true, lent
		q.used++
		q.held[next]++
		close(w.ready)
	}
}

// drop takes w out of the line, its cluster out of the order with no waiter left; a cluster served goes to the back.
func (q *openingQueue) drop(w *openingWaiter, served bool) {
	ws := q.waiting[w.cluster]
	for i, x := range ws {
		if x == w {
			ws = append(ws[:i:i], ws[i+1:]...)
			break
		}
	}
	if len(ws) == 0 {
		delete(q.waiting, w.cluster)
		for i, c := range q.order {
			if c == w.cluster {
				q.order = append(q.order[:i:i], q.order[i+1:]...)
				break
			}
		}
		return
	}
	q.waiting[w.cluster] = ws
	if served {
		for i, c := range q.order {
			if c == w.cluster {
				q.order = append(append(q.order[:i:i], q.order[i+1:]...), w.cluster)
				break
			}
		}
	}
}
