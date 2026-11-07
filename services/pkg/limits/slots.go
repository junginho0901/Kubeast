package limits

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// slotWaitLogEvery bounds the log line that says a limit was reached: a crowd waits thousands of times a minute.
const slotWaitLogEvery = 10 * time.Second

// Slots is a fixed number of places for expensive work: a caller past the number waits its turn instead of being
// refused, and the waits are logged so a limit that is often reached can be seen.
type Slots struct {
	name    string
	places  chan struct{}
	waits   atomic.Int64
	longest atomic.Int64
	nextLog atomic.Int64
}

// NewSlots makes n places (at least one) named for the log.
func NewSlots(name string, n int) *Slots {
	if n < 1 {
		n = 1
	}
	return &Slots{name: name, places: make(chan struct{}, n)}
}

// Take waits for a place until ctx ends and returns the function that gives it back.
func (s *Slots) Take(ctx context.Context) (func(), error) {
	select {
	case s.places <- struct{}{}:
		return s.give, nil
	default:
	}
	start := time.Now()
	select {
	case s.places <- struct{}{}:
		s.noteWait(time.Since(start))
		return s.give, nil
	case <-ctx.Done():
		s.noteWait(time.Since(start))
		return nil, ctx.Err()
	}
}

func (s *Slots) give() { <-s.places }

// Cap is the number of places.
func (s *Slots) Cap() int { return cap(s.places) }

// InUse is how many places are taken now.
func (s *Slots) InUse() int { return len(s.places) }

func (s *Slots) noteWait(d time.Duration) {
	s.waits.Add(1)
	ms := d.Milliseconds()
	for {
		old := s.longest.Load()
		if ms <= old || s.longest.CompareAndSwap(old, ms) {
			break
		}
	}
	now := time.Now().UnixNano()
	next := s.nextLog.Load()
	if now < next || !s.nextLog.CompareAndSwap(next, now+int64(slotWaitLogEvery)) {
		return
	}
	slog.Info("waited for a place", "what", s.name, "places", cap(s.places), "waits", s.waits.Swap(0), "longest_ms", s.longest.Swap(0))
}
