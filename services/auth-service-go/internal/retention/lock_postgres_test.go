package retention

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// Against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (freshMigratedDatabase; skipped when unset).

func seedRows(t *testing.T, pool *pgxpool.Pool, at time.Time, stmts ...string) {
	t.Helper()
	for _, stmt := range stmts {
		args := []any{at}
		if !strings.Contains(stmt, "$1") {
			args = nil
		}
		if _, err := pool.Exec(context.Background(), stmt, args...); err != nil {
			t.Fatalf("seed %q: %v", stmt[:40], err)
		}
	}
}

// mayTakeLock reports whether a session other than the purge's takes LockKey now, and gives it back.
func mayTakeLock(t *testing.T, conn *pgxpool.Conn) bool {
	t.Helper()
	ctx := context.Background()
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, LockKey).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	if ok {
		if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, LockKey); err != nil {
			t.Fatal(err)
		}
	}
	return ok
}

// A turn that comes while another replica's run holds the lock leaves it to that run: the run started first deletes
// everything and writes the one row, open_approvals and all, and the later turn deletes nothing and writes nothing.
// The later turn is taken inside the first run, from its sink floor call, before that run has deleted anything.
func TestPostgresATurnTakenDuringAnotherRunLeavesItToThatRun(t *testing.T) {
	pool := freshMigratedDatabase(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	seedRows(t, pool, now.AddDate(0, 0, -400),
		`INSERT INTO auth_users (id, name, email, password_hash) VALUES ('u1', 'U', 'u1@example.com', 'x')`,
		`INSERT INTO auth_audit_logs (service, action, created_at) VALUES ('auth', 'user.login.success', $1), ('auth', 'user.login.success', $1)`,
		`INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES ('s-old', 'u1', 'old', $1, $1)`,
		`INSERT INTO tool_approvals (id, session_id, user_id, user_email, cluster, tool, args, status, created_at, expires_at, decided_at) VALUES
		   ('a-1', 's-old', 'u1', 'u1@example.com', 'self', 'k8s_scale', '{}', 'approved', $1, $1, $1),
		   ('a-2', 's-old', 'u1', 'u1@example.com', 'prod', 'k8s_patch_resource', '{}', 'approved', $1, $1, $1)`)

	cfg := Config{AuditDays: 365, ChatDays: 180}
	lock := PGLock{Pool: pool}
	first, later := &captureWriter{}, &captureWriter{}
	var floorAsked bool
	Purger{Pool: pool, Cfg: cfg, Audit: first, Now: func() time.Time { return now },
		AuditFloor: func(ctx context.Context) (int64, error) {
			floorAsked = true
			Purger{Pool: pool, Cfg: cfg, Audit: later, Now: func() time.Time { return now }}.turn(ctx, lock)
			return math.MaxInt64, nil
		}}.turn(ctx, lock)

	if !floorAsked {
		t.Fatal("the first run never asked its sink floor")
	}
	if len(later.recs) != 0 {
		t.Fatalf("the turn taken during another run wrote %d rows, the first %s", len(later.recs), later.recs[0].After)
	}
	if len(first.recs) != 1 || first.recs[0].Result != audit.ResultSuccess {
		t.Fatalf("first run's records = %+v", first.recs)
	}
	var after struct {
		AuditRows     int64          `json:"audit_rows"`
		Sessions      int64          `json:"sessions"`
		ToolApprovals int64          `json:"tool_approvals"`
		OpenApprovals []OpenApproval `json:"open_approvals"`
	}
	if err := json.Unmarshal(first.recs[0].After, &after); err != nil {
		t.Fatal(err)
	}
	if after.AuditRows != 2 || after.Sessions != 1 || after.ToolApprovals != 2 || len(after.OpenApprovals) != 2 {
		t.Fatalf("first run's row = %s; want 2 audit rows, 1 session, 2 tool approvals, both named open", first.recs[0].After)
	}
	for _, table := range []string{"auth_audit_logs", "sessions", "tool_approvals"} {
		if n := count(t, pool, table); n != 0 {
			t.Fatalf("%s left = %d, want 0", table, n)
		}
	}
}

// While another session holds LockKey a turn deletes nothing and writes no row; once it is free the turn runs, and
// gives the lock back when it ends.
func TestPostgresATurnWhileTheLockIsHeldElsewhereDeletesNothing(t *testing.T) {
	pool := freshMigratedDatabase(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	seedRows(t, pool, now.AddDate(0, 0, -100),
		`INSERT INTO auth_audit_logs (service, action, created_at) VALUES ('auth', 'x', $1), ('auth', 'x', $1), ('auth', 'x', $1)`)
	other, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Release()
	var held bool
	if err := other.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, LockKey).Scan(&held); err != nil || !held {
		t.Fatalf("pg_try_advisory_lock = %v, %v", held, err)
	}

	w := &captureWriter{}
	p := Purger{Pool: pool, Cfg: Config{AuditDays: 30}, Audit: w, Now: func() time.Time { return now }}
	p.turn(ctx, PGLock{Pool: pool})
	if n := count(t, pool, "auth_audit_logs"); n != 3 || len(w.recs) != 0 {
		t.Fatalf("with the lock held elsewhere: %d rows left, %d records; want 3 and 0", n, len(w.recs))
	}

	if _, err := other.Exec(ctx, `SELECT pg_advisory_unlock($1)`, LockKey); err != nil {
		t.Fatal(err)
	}
	p.turn(ctx, PGLock{Pool: pool})
	if n := count(t, pool, "auth_audit_logs"); n != 0 || len(w.recs) != 1 || w.recs[0].Result != audit.ResultSuccess {
		t.Fatalf("with the lock free: %d rows left, records %+v; want 0 and one success", n, w.recs)
	}
	if !mayTakeLock(t, other) {
		t.Fatal("the lock is still held after the turn ended")
	}
}

// A run stopped part way (the service's context ends on SIGTERM) still gives the lock back, so the other replicas'
// turns are not left to a run that is gone.
func TestPostgresARunStoppedPartWayLeavesNoLockBehind(t *testing.T) {
	pool := freshMigratedDatabase(t)
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	seedRows(t, pool, now.AddDate(0, 0, -100), `INSERT INTO auth_audit_logs (service, action, created_at) VALUES ('auth', 'x', $1)`)
	other, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Release()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &captureWriter{}
	Purger{Pool: pool, Cfg: Config{AuditDays: 30}, Audit: w, Now: func() time.Time { return now },
		AuditFloor: func(context.Context) (int64, error) {
			cancel()
			return 0, context.Canceled
		}}.turn(ctx, PGLock{Pool: pool})

	if len(w.recs) != 1 || w.recs[0].Result != audit.ResultFailure {
		t.Fatalf("records = %+v, want the stopped run's failure", w.recs)
	}
	if !mayTakeLock(t, other) {
		t.Fatal("the lock is still held after the stopped run")
	}
}

// poolWriter writes a row after a statement on its pool, as the service's audit store writes through the service's
// pool.
type poolWriter struct {
	pool *pgxpool.Pool
	recs []audit.Record
}

func (w *poolWriter) Write(ctx context.Context, rec audit.Record) (int64, error) {
	if _, err := w.pool.Exec(ctx, `SELECT 1`); err != nil {
		return 0, err
	}
	w.recs = append(w.recs, rec)
	return int64(len(w.recs)), nil
}

// With a pool of one connection (postgresql.pool.authService.maxConns: 1) a turn runs to its row: the lock is held on
// a connection of its own, so the chain floor, the sink floor, the deletes and the row each get the pool's one
// connection. A lock held on that connection would leave them waiting for it until the deadline below.
func TestPostgresATurnWithAPoolOfOneConnectionRunsToItsRow(t *testing.T) {
	pool := freshMigratedDatabase(t)
	now := time.Date(2026, 11, 21, 3, 0, 0, 0, time.UTC)
	seedRows(t, pool, now.AddDate(0, 0, -100),
		`INSERT INTO auth_audit_logs (service, action, created_at) VALUES ('auth', 'x', $1), ('auth', 'x', $1)`)
	cfg := pool.Config()
	cfg.MaxConns, cfg.MinConns = 1, 0
	one, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(one.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	w := &poolWriter{pool: one}
	Purger{Pool: one, Cfg: Config{AuditDays: 30}, Audit: w, Now: func() time.Time { return now },
		AuditFloor: func(ctx context.Context) (int64, error) {
			_, err := one.Exec(ctx, `SELECT 1`) // auditsink.Floor reads the sinks' cursors through the pool
			return math.MaxInt64, err
		}}.turn(ctx, PGLock{Pool: one})

	if ctx.Err() != nil {
		t.Fatalf("the turn ran into its 10 s deadline (records %+v): its statements waited for the pool's one connection", w.recs)
	}
	if len(w.recs) != 1 || w.recs[0].Result != audit.ResultSuccess {
		t.Fatalf("records = %+v, want one success", w.recs)
	}
	if n := count(t, pool, "auth_audit_logs"); n != 0 {
		t.Fatalf("auth_audit_logs left = %d, want 0", n)
	}
}
