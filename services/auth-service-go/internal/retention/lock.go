package retention

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LockKey is the PostgreSQL advisory lock a purge run holds, so that of several auth-service replicas one purges at
// a time (arbitrary constant: "kbretent"). The database's other advisory lock keys, which it differs from: auth-service's
// audit sinks 0x6b62617564736e6b (internal/auditsink) and audit chain 7_432_119_027 and 7_432_119_028
// (internal/auditchain), k8s-service's health status writer 0x6b62686c74687374 (healthStatusLockKey) and ai-service's
// hourly investigation cap 0x4B55424541535448 (HOURLY_CAP_LOCK in app/services/investigation/store.py).
const LockKey int64 = 0x6b62726574656e74

// unlockWait bounds the unlock and the close of the lock's connection at the end of a run, which have a context of
// their own: the run's has ended when SIGTERM stopped it.
const unlockWait = 5 * time.Second

// Locker gives the turn to one replica at a time. TryLock does not wait: ok is false while another replica holds the
// lock, and release gives it back.
type Locker interface {
	TryLock(ctx context.Context) (release func(), ok bool, err error)
}

// turn is one scheduled run, taken through lock. A replica whose turn comes while another replica's run holds the lock
// leaves the turn to that run, which deletes what both would have and writes the one admin.retention.purge row, so a
// run's counts (open_approvals among them) are never split over two rows. The lock is held until that row is written.
// A lock that cannot be asked (the database down) is a failed run, recorded as RunOnce records one.
func (p Purger) turn(ctx context.Context, lock Locker) {
	release, ok, err := lock.TryLock(ctx)
	if err != nil {
		now := time.Now()
		if p.Now != nil {
			now = p.Now()
		}
		err = fmt.Errorf("retention: lock: %w", err)
		slog.Error("retention: purge not run", "error", err)
		p.record(ctx, now, Result{}, nil, err)
		return
	}
	if !ok {
		slog.Info("retention: another replica is purging; this turn is left to it")
		return
	}
	defer release()
	p.RunOnce(ctx)
}

// PGLock is the Locker over the shared database: pg_try_advisory_lock on a connection of its own, made with the
// pool's settings for the run and closed when it ends, outside the pool as k8s-service's internal/pglock. The purge's
// statements, the sink floor and the run's audit row go through the pool, a batch of conversations in one short
// transaction and every other batch a statement of its own, so no transaction stays open for the run, and a pool of
// one connection (postgresql.pool.authService.maxConns: 1, or 2 beside the audit sinks' leader lock) still has that
// connection for them while the lock is held. The lock ends with its connection's session: a replica stopped mid-run
// (SIGTERM, a crash) gives it back as the run ends or its connection closes; one whose node is gone holds it until
// PostgreSQL drops that connection, and the turns that come meanwhile are left to it, the next day's run deleting what
// they would have.
type PGLock struct{ Pool *pgxpool.Pool }

// TryLock takes the lock on a new connection; ok is false while another session holds it, and that connection is
// closed then.
func (l PGLock) TryLock(ctx context.Context) (func(), bool, error) {
	conn, err := pgx.ConnectConfig(ctx, l.Pool.Config().ConnConfig)
	if err != nil {
		return nil, false, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, LockKey).Scan(&ok); err != nil || !ok {
		cctx, cancel := context.WithTimeout(context.Background(), unlockWait)
		defer cancel()
		_ = conn.Close(cctx)
		return nil, false, err
	}
	return func() {
		uctx, cancel := context.WithTimeout(context.Background(), unlockWait)
		defer cancel()
		if _, err := conn.Exec(uctx, `SELECT pg_advisory_unlock($1)`, LockKey); err != nil {
			slog.Warn("retention: unlock failed; the lock goes with its connection's session", "error", err)
		}
		_ = conn.Close(uctx)
	}, true, nil
}
