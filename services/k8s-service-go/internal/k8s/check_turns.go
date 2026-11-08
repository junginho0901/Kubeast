package k8s

import (
	"context"
	"hash/maphash"
	"sync"
	"time"

	"golang.org/x/time/rate"
	"k8s.io/client-go/util/flowcontrol"
)

// passOverLimit is the longest an access check asked again lets later requests go first: 1 000 first checks at 100 a second.
var passOverLimit = 10 * time.Second

type askedAgainKey struct{}

// askingAgain marks ctx's requests as an access check asked again after its remembered answer ran out.
func askingAgain(ctx context.Context) context.Context {
	return context.WithValue(ctx, askedAgainKey{}, true)
}

func isAskedAgain(ctx context.Context) bool {
	again, _ := ctx.Value(askedAgainKey{}).(bool)
	return again
}

// turnLimiter is client-go's token bucket at the same rate and burst that gives a token to checks asked again only when nothing else waits or they waited passOverLimit.
type turnLimiter struct {
	qps     float32
	mu      sync.Mutex
	bucket  *rate.Limiter
	first   []*turnWaiter // in arrival order, as again
	again   []*turnWaiter
	serving bool
}

type turnWaiter struct {
	again bool
	since time.Time
	ready chan struct{}
	took  *rate.Reservation
}

var _ flowcontrol.RateLimiter = (*turnLimiter)(nil)

func newTurnLimiter(qps float32, burst int) *turnLimiter {
	return &turnLimiter{qps: qps, bucket: rate.NewLimiter(rate.Limit(qps), max(burst, 1))}
}

func (l *turnLimiter) QPS() float32 { return l.qps }

func (l *turnLimiter) Stop() {}

func (l *turnLimiter) TryAccept() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.waiting() == 0 && l.bucket.AllowN(time.Now(), 1)
}

func (l *turnLimiter) Accept() { _ = l.Wait(context.Background()) }

// Wait returns once ctx's request has a token, or with ctx's error, giving back a token that came as it ended.
func (l *turnLimiter) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	l.mu.Lock()
	w := l.arrive(time.Now(), isAskedAgain(ctx))
	if w == nil {
		l.mu.Unlock()
		return nil
	}
	if !l.serving {
		l.serving = true
		go l.serve()
	}
	l.mu.Unlock()
	select {
	case <-w.ready:
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		defer l.mu.Unlock()
		if w.took != nil {
			w.took.CancelAt(time.Now())
		} else {
			l.leave(w)
		}
		return ctx.Err()
	}
}

// serve hands out each token as the bucket makes it good, to the waiter whose turn it is then, until no one waits.
func (l *turnLimiter) serve() {
	for {
		l.mu.Lock()
		r, delay, ok := l.reserve(time.Now())
		if !ok {
			l.serving = false
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()
		time.Sleep(delay)
		l.mu.Lock()
		l.give(r, time.Now())
		l.mu.Unlock()
	}
}

// arrive takes a token at once when no one waits and the bucket has one (nil), else queues the request. l.mu held.
func (l *turnLimiter) arrive(now time.Time, again bool) *turnWaiter {
	if l.waiting() == 0 && l.bucket.AllowN(now, 1) {
		return nil
	}
	w := &turnWaiter{again: again, since: now, ready: make(chan struct{})}
	if again {
		l.again = append(l.again, w)
	} else {
		l.first = append(l.first, w)
	}
	return w
}

// reserve takes the bucket's next token while someone waits, with how long until it is good. l.mu held.
func (l *turnLimiter) reserve(now time.Time) (*rate.Reservation, time.Duration, bool) {
	if l.waiting() == 0 {
		return nil, 0, false
	}
	r := l.bucket.ReserveN(now, 1)
	return r, r.DelayFrom(now), true
}

// give hands r to the waiter whose turn it is at now, or back to the bucket when all have left. l.mu held.
func (l *turnLimiter) give(r *rate.Reservation, now time.Time) *turnWaiter {
	w := l.next(now)
	if w == nil {
		r.CancelAt(now)
		return nil
	}
	w.took = r
	close(w.ready)
	return w
}

// next takes the oldest request not asked again, unless the oldest check asked again came first and waited passOverLimit. l.mu held.
func (l *turnLimiter) next(now time.Time) *turnWaiter {
	q := &l.first
	switch {
	case len(l.again) == 0:
	case len(l.first) == 0:
		q = &l.again
	case now.Sub(l.again[0].since) >= passOverLimit && l.again[0].since.Before(l.first[0].since):
		q = &l.again
	}
	if len(*q) == 0 {
		return nil
	}
	w := (*q)[0]
	(*q)[0] = nil
	*q = (*q)[1:]
	return w
}

func (l *turnLimiter) waiting() int { return len(l.first) + len(l.again) }

// leave takes w out of its queue. l.mu held.
func (l *turnLimiter) leave(w *turnWaiter) {
	q := &l.first
	if w.again {
		q = &l.again
	}
	for i, x := range *q {
		if x == w {
			*q = append((*q)[:i], (*q)[i+1:]...)
			return
		}
	}
}

// answeredChecks is which access questions this process answered, until a minute past their answer's end: at most answeredMax of about 20 bytes.
type answeredChecks struct {
	mu    sync.Mutex
	seed  maphash.Seed
	until map[uint64]int64
}

const answeredMax = 1 << 16

// answered notes that key's answer is remembered until end.
func (a *answeredChecks) answered(key string, end time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.until == nil {
		a.seed, a.until = maphash.MakeSeed(), map[uint64]int64{}
	}
	if len(a.until) >= answeredMax {
		now := time.Now().UnixNano()
		for k, u := range a.until {
			if u <= now {
				delete(a.until, k)
			}
		}
		if len(a.until) >= answeredMax {
			return
		}
	}
	a.until[maphash.String(a.seed, key)] = end.Add(podAccessTTL).UnixNano()
}

// askedAgain says whether key was answered and that answer ended less than a minute before now.
func (a *answeredChecks) askedAgain(key string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.until == nil {
		return false
	}
	u, ok := a.until[maphash.String(a.seed, key)]
	return ok && u > now.UnixNano()
}
