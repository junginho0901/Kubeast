package limits

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// No more than the places run at once, every caller gets its turn, and all the places are free afterwards.
func TestSlotsLetInNoMoreThanThePlacesAndEveryoneGetsATurn(t *testing.T) {
	s := NewSlots("test", 3)
	var running, most, done atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := s.Take(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			defer release()
			n := running.Add(1)
			for {
				m := most.Load()
				if n <= m || most.CompareAndSwap(m, n) {
					break
				}
			}
			time.Sleep(2 * time.Millisecond)
			running.Add(-1)
			done.Add(1)
		}()
	}
	wg.Wait()
	if most.Load() != 3 {
		t.Errorf("at most %d ran at once, want 3", most.Load())
	}
	if done.Load() != 40 {
		t.Errorf("%d of 40 callers ran", done.Load())
	}
	if s.InUse() != 0 {
		t.Errorf("%d places still taken", s.InUse())
	}
}

// A caller that goes away while waiting holds nothing.
func TestSlotsLetAWaitingCallerLeave(t *testing.T) {
	s := NewSlots("test", 1)
	release, err := s.Take(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := s.Take(ctx); err != context.DeadlineExceeded {
		t.Fatalf("waiting past its deadline: %v", err)
	}
	if s.InUse() != 1 {
		t.Fatalf("%d places taken, want the one held", s.InUse())
	}
	release()
	if s.InUse() != 0 {
		t.Fatalf("%d places taken after the release", s.InUse())
	}
}

func TestSlotsHaveAtLeastOnePlace(t *testing.T) {
	if got := NewSlots("test", 0).Cap(); got != 1 {
		t.Fatalf("cap = %d", got)
	}
}
