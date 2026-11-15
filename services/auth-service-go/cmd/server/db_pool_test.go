package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
	"github.com/junginho0901/kubeast/services/pkg/dbsession/dbsessiontest"
)

// O-27: no pool set statement_timeout, lock_timeout or idle_in_transaction_session_timeout (PostgreSQL's default for
// each is 0, no limit), so a statement that did not end or a transaction left open held its locks and a connection
// of the pool until the pod went. The limits are SET once a connection is made, so a pooler that refuses unknown
// startup parameters still connects.

// pingThrough opens cfg's pool against srv and pings it once.
func pingThrough(t *testing.T, cfg *pgxpool.Config) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

func assertSetFirst(t *testing.T, srv *dbsessiontest.Server, want string) {
	t.Helper()
	q := srv.Queries()
	if len(q) == 0 || q[0] != want {
		t.Fatalf("first query = %q, want %q", q, want)
	}
	for _, s := range srv.Startups() {
		for _, p := range []string{"statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "options"} {
			if v, ok := s[p]; ok {
				t.Fatalf("startup message holds %s=%q", p, v)
			}
		}
	}
}

func TestPoolSetsTheSessionLimitsOnEachConnection(t *testing.T) {
	t.Setenv(envPoolMaxConns, "")
	srv := dbsessiontest.Start(t)
	cfg, err := newPoolConfig(srv.URL(), dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 20 || cfg.MinConns != 2 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 20, 2", cfg.MaxConns, cfg.MinConns)
	}
	if len(cfg.ConnConfig.RuntimeParams) != 0 {
		t.Fatalf("RuntimeParams = %v, want none (the limits are SET after connecting)", cfg.ConnConfig.RuntimeParams)
	}
	pingThrough(t, cfg)
	assertSetFirst(t, srv, dbsession.Defaults.Statements())
}

func TestPoolSizeComesFromTheEnvironment(t *testing.T) {
	t.Setenv(envPoolMaxConns, "5")
	cfg, err := newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 5 || cfg.MinConns != 2 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 5, 2", cfg.MaxConns, cfg.MinConns)
	}
	t.Setenv(envPoolMaxConns, "1")
	cfg, err = newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 1 || cfg.MinConns != 1 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 1, 1 (MinConns never above MaxConns)", cfg.MaxConns, cfg.MinConns)
	}
}

func TestPoolTakesTheLimitsFromTheEnvironment(t *testing.T) {
	t.Setenv(dbsession.EnvStatementTimeout, "45000")
	t.Setenv(dbsession.EnvLockTimeout, "0")
	t.Setenv(dbsession.EnvIdleInTransaction, "")
	srv := dbsessiontest.Start(t)
	cfg, err := newPoolConfig(srv.URL(), dbsession.FromEnv())
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	pingThrough(t, cfg)
	assertSetFirst(t, srv, "SET statement_timeout = 45000; SET idle_in_transaction_session_timeout = 300000")
}

func TestMigrationPoolHasNoStatementOrLockLimit(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg, err := newMigrationPoolConfig(srv.URL(), dbsession.Defaults)
	if err != nil {
		t.Fatalf("newMigrationPoolConfig: %v", err)
	}
	if cfg.MaxConns != dbsession.MigrationPoolMaxConns || cfg.MinConns != 0 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want %d, 0", cfg.MaxConns, cfg.MinConns, dbsession.MigrationPoolMaxConns)
	}
	pingThrough(t, cfg)
	assertSetFirst(t, srv, "SET statement_timeout = 0; SET lock_timeout = 0; SET idle_in_transaction_session_timeout = 300000")
}

// With every limit at 0 (the limits on the role, behind RDS Proxy) the migration pool still lifts the statement and
// lock limits the role would give it.
func TestMigrationPoolLiftsTheStatementAndLockLimitsWithEveryLimitZero(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg, err := newMigrationPoolConfig(srv.URL(), dbsession.Limits{})
	if err != nil {
		t.Fatalf("newMigrationPoolConfig: %v", err)
	}
	pingThrough(t, cfg)
	assertSetFirst(t, srv, "SET statement_timeout = 0; SET lock_timeout = 0")
}
