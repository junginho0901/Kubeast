package auditsink

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL over TCP (the server ignores keepalives on a Unix
// socket); skipped when unset. The lock needs no schema. A pool of one connection gives the same connection back, so
// what the lock left on it can be read.
func onePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("DBMIGRATE_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

type session struct {
	pid                   int32
	idle, interval, count string
	advisoryLocks         int64
}

func readSession(t *testing.T, conn *pgxpool.Conn) session {
	t.Helper()
	var s session
	if err := conn.QueryRow(context.Background(), `SELECT pg_backend_pid(), current_setting('tcp_keepalives_idle'),
		current_setting('tcp_keepalives_interval'), current_setting('tcp_keepalives_count'),
		(SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid())`).
		Scan(&s.pid, &s.idle, &s.interval, &s.count, &s.advisoryLocks); err != nil {
		t.Fatal(err)
	}
	return s
}

// The lock's connection asks the server for keepalives (10 s quiet, every 5 s, 3 probes), so a sending replica whose
// node is gone loses the lock within about 25 s and another takes it.
func TestPostgresTheLockConnectionHasKeepalives(t *testing.T) {
	p := onePool(t)
	ctx := context.Background()
	conn, err := PG{Pool: p}.lockConn(ctx)
	if conn == nil {
		t.Fatalf("a replica alone did not take the lock: %v", err)
	}
	// closing the connection ends its session and the lock with it
	t.Cleanup(func() { _ = conn.Conn().Close(ctx); conn.Release() })
	s := readSession(t, conn)
	if s.idle != "10" || s.interval != "5" || s.count != "3" {
		t.Fatalf("keepalives idle %s, interval %s, count %s; want 10, 5, 3", s.idle, s.interval, s.count)
	}
	if s.advisoryLocks != 1 {
		t.Fatalf("the connection holds %d advisory locks; want the one", s.advisoryLocks)
	}
}

// Given back, the lock's connection returns to the pool without the lock and with the keepalives it had before.
func TestPostgresTheLockConnectionGoesBackAsItCame(t *testing.T) {
	p := onePool(t)
	ctx := context.Background()
	c, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	before := readSession(t, c)
	c.Release()
	release, _, ok, err := PG{Pool: p}.TryLock(ctx)
	if !ok {
		t.Fatalf("a replica alone did not take the lock: %v", err)
	}
	release()
	c, err = p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Release()
	after := readSession(t, c)
	if after.pid != before.pid {
		t.Fatalf("the pool gave another connection (backend %d, then %d)", before.pid, after.pid)
	}
	if after != before {
		t.Fatalf("the connection came back as %+v; it was %+v", after, before)
	}
}
