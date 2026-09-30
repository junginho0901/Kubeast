package handler

import "time"

// Login lockout (H13). A password failure counts inside an observation
// window that starts at the first failure; reaching the threshold locks the
// account for the same duration. Locks are temporary so a stranger who knows
// an email can delay, not deny, its owner. A successful login clears the
// counter. The decision is pure so it can be tested without a database.

// lockoutState is what auth_users carries for one account.
type lockoutState struct {
	Failures    int
	LastFailure time.Time // zero = none
	LockedUntil time.Time // zero = not locked
}

// isLocked reports whether the account may not attempt a password login now.
func (s lockoutState) isLocked(now time.Time) bool {
	return !s.LockedUntil.IsZero() && now.Before(s.LockedUntil)
}

// afterFailure returns the state after one more password failure at now.
// window is both the observation window and the lock duration; threshold is
// the number of failures that locks. locked reports whether this failure is
// the one that locked the account.
func (s lockoutState) afterFailure(now time.Time, threshold int, window time.Duration) (next lockoutState, locked bool) {
	next = s
	if s.LastFailure.IsZero() || now.Sub(s.LastFailure) > window {
		next.Failures = 0 // the previous streak is outside the window
	}
	next.Failures++
	next.LastFailure = now
	if threshold > 0 && next.Failures >= threshold {
		next.LockedUntil = now.Add(window)
		return next, true
	}
	return next, false
}
