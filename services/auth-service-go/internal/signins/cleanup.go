// Package signins deletes the signed-out sign-ins (ended_sign_ins) that can no longer matter.
//
// After a sign-out, refresh refuses the sign-in, so its last token was issued before the sign-out (or by a refresh
// under way at that moment) and expires within the token lifetime. Past that and Margin — a service's cached answer
// (30 s), an open connection's next check (30 s) and the five minutes a service goes on with an answer it cached while
// it cannot ask — nothing of the sign-in is accepted anywhere, with or without SESSION_ABSOLUTE_HOURS.
package signins

import (
	"context"
	"log/slog"
	"time"
)

// Margin is how long past the token lifetime a signed-out sign-in is kept.
const Margin = 10 * time.Minute

// batch is how many rows one statement deletes.
const batch = 500

// Store is the database side (repository.Repository).
type Store interface {
	DeleteEndedSignIns(ctx context.Context, keep time.Duration, batch int) (int64, error)
}

// Cleaner deletes the signed-out sign-ins that ended more than Keep ago.
type Cleaner struct {
	Store Store
	Keep  time.Duration
}

// KeepFor is how long a signed-out sign-in is kept when tokens live tokenLifetime.
func KeepFor(tokenLifetime time.Duration) time.Duration {
	return tokenLifetime + Margin
}

// Run cleans once now and then every `every`, until ctx is done.
func Run(ctx context.Context, c Cleaner, every time.Duration) {
	c.RunOnce(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.RunOnce(ctx)
		}
	}
}

// RunOnce deletes batch by batch until a batch comes back short and says how many rows went. A failure is logged and
// left for the next run: a row kept longer ends nothing it should not.
func (c Cleaner) RunOnce(ctx context.Context) int64 {
	var total int64
	for ctx.Err() == nil {
		n, err := c.Store.DeleteEndedSignIns(ctx, c.Keep, batch)
		if err != nil {
			slog.Warn("signed-out sign-ins: cleanup failed", "error", err)
			return total
		}
		total += n
		if n < batch {
			break
		}
	}
	return total
}
