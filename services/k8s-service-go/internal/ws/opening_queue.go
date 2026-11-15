package ws

import (
	"context"
	"sync"
)

// openingQueue is the server's places for the objects watches from no version open with, one set for every cluster
// since the memory they take is the process's (watchMemoryShare). A cluster takes them as follows:
//   - one at a time until it has answered a start within startHoldFor, and again once a start of it has not
//     (answering), so a cluster that does not answer holds one place, for one start's time;
//   - up to half of them while a cluster under its own limit waits for one;
//   - and every free place otherwise, so a server with one cluster opens as many lists at once as it has places.
//
// The waiting clusters take turns: a cluster that got a place goes to the back of the line.
type openingQueue struct {
	mu        sync.Mutex
	size      int
	used      int
	held      map[string]int
	waiting   map[string][]*openingWaiter
	order     []string // clusters with waiters, the next one to be served first
	answering map[string]bool
}

type openingWaiter struct {
	cluster string
	granted bool
	ready   chan struct{}
}

func newOpeningQueue(size int) *openingQueue {
	return &openingQueue{size: max(1, size), held: map[string]int{}, waiting: map[string][]*openingWaiter{}, answering: map[string]bool{}}
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

// placesFor takes cluster's places in the queue as takeTurn takes places.
func (q *openingQueue) placesFor(cluster string) placeTaker {
	return queuePlace{q: q, cluster: cluster}
}

type queuePlace struct {
	q       *openingQueue
	cluster string
}

func (p queuePlace) Take(ctx context.Context) (func(), error) { return p.q.take(ctx, p.cluster) }

// take waits for one of the places for cluster until ctx ends and returns the function that gives it back.
func (q *openingQueue) take(ctx context.Context, cluster string) (func(), error) {
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
		return sync.OnceFunc(func() { q.give(cluster) }), nil
	case <-ctx.Done():
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if w.granted {
		q.used--
		q.held[cluster]--
	} else {
		q.drop(w)
	}
	q.grant()
	return nil, ctx.Err()
}

func (q *openingQueue) give(cluster string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.used--
	q.held[cluster]--
	if q.held[cluster] == 0 {
		delete(q.held, cluster)
	}
	q.grant()
}

// setAnswering says whether cluster answered its last start within startHoldFor.
func (q *openingQueue) setAnswering(cluster string, answering bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.answering[cluster] == answering {
		return
	}
	if answering {
		q.answering[cluster] = true
	} else {
		delete(q.answering, cluster)
	}
	q.grant()
}

// limit is how many places cluster may hold while a cluster under its own limit waits.
func (q *openingQueue) limit(cluster string) int {
	if !q.answering[cluster] {
		return 1
	}
	return max(1, q.size/2)
}

// grant gives the free places to the waiters, in turn: first the clusters under their limit, then, when none waits,
// the answering clusters past it.
func (q *openingQueue) grant() {
	for q.used < q.size {
		next := ""
		for _, c := range q.order {
			if q.held[c] < q.limit(c) {
				next = c
				break
			}
		}
		if next == "" {
			for _, c := range q.order {
				if q.answering[c] {
					next = c
					break
				}
			}
		}
		if next == "" {
			return
		}
		w := q.waiting[next][0]
		q.drop(w)
		w.granted = true
		q.used++
		q.held[next]++
		close(w.ready)
	}
}

// drop takes w out of the line; its cluster goes to the back of the order, or out of it with no waiter left.
func (q *openingQueue) drop(w *openingWaiter) {
	ws := q.waiting[w.cluster]
	for i, x := range ws {
		if x == w {
			ws = append(ws[:i:i], ws[i+1:]...)
			break
		}
	}
	for i, c := range q.order {
		if c == w.cluster {
			q.order = append(q.order[:i:i], q.order[i+1:]...)
			break
		}
	}
	if len(ws) == 0 {
		delete(q.waiting, w.cluster)
		return
	}
	q.waiting[w.cluster] = ws
	q.order = append(q.order, w.cluster)
}
