package handler

import (
	"testing"
	"time"
)

func TestLockoutState(t *testing.T) {
	t0 := time.Date(2026, 9, 30, 7, 0, 0, 0, time.UTC)
	window := 15 * time.Minute

	var s lockoutState
	if s.isLocked(t0) {
		t.Fatal("fresh account must not be locked")
	}
	// Four failures inside the window: counted, not locked.
	for i := 1; i <= 4; i++ {
		var locked bool
		s, locked = s.afterFailure(t0.Add(time.Duration(i)*time.Minute), 5, window)
		if locked || s.Failures != i || s.isLocked(t0.Add(time.Duration(i)*time.Minute)) {
			t.Fatalf("failure %d: locked=%v failures=%d", i, locked, s.Failures)
		}
	}
	// The fifth locks for the window length.
	s, locked := s.afterFailure(t0.Add(5*time.Minute), 5, window)
	if !locked || !s.isLocked(t0.Add(6*time.Minute)) || !s.LockedUntil.Equal(t0.Add(20*time.Minute)) {
		t.Fatalf("fifth failure must lock until t0+20m: locked=%v state=%+v", locked, s)
	}
	// Once the lock expires the account may try again.
	if s.isLocked(t0.Add(20 * time.Minute)) {
		t.Fatal("lock must end at locked_until")
	}
	// A streak older than the window starts over instead of locking at once.
	old := lockoutState{Failures: 4, LastFailure: t0}
	s2, locked := old.afterFailure(t0.Add(window+time.Second), 5, window)
	if locked || s2.Failures != 1 {
		t.Fatalf("stale streak must reset: locked=%v failures=%d", locked, s2.Failures)
	}
	// A streak still inside the window keeps counting.
	s3, locked := old.afterFailure(t0.Add(window), 5, window)
	if !locked || s3.Failures != 5 {
		t.Fatalf("streak inside the window must lock: locked=%v failures=%d", locked, s3.Failures)
	}
	// Threshold 0 disables locking.
	s4, locked := lockoutState{Failures: 99}.afterFailure(t0, 0, window)
	if locked || !s4.LockedUntil.IsZero() {
		t.Fatal("threshold 0 must never lock")
	}
}
