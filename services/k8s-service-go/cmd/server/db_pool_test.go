package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
	"github.com/junginho0901/kubeast/services/pkg/dbsession/dbsessiontest"
)

// O-27: the pool set no session limits (PostgreSQL's default is 0, no limit for each) and took pgxpool's
// max(4, NumCPU) connections. The limits are SET once a connection is made; the size is DB_POOL_MAX_K8S, 10 by default.

func TestPoolSetsTheSessionLimitsOnEachConnection(t *testing.T) {
	t.Setenv(envPoolMaxConns, "")
	srv := dbsessiontest.Start(t)
	cfg, err := newPoolConfig(srv.URL(), dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 10 || cfg.MinConns != 0 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 10, 0", cfg.MaxConns, cfg.MinConns)
	}
	if len(cfg.ConnConfig.RuntimeParams) != 0 {
		t.Fatalf("RuntimeParams = %v, want none", cfg.ConnConfig.RuntimeParams)
	}
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
	if q := srv.Queries(); len(q) == 0 || q[0] != dbsession.Defaults.Statements() {
		t.Fatalf("first query = %q, want %q", q, dbsession.Defaults.Statements())
	}
}

// A connection copied from the pool's settings (as a lock held on a connection of its own copies them) sets the
// limits too: they live in the connection config, not only in the pool.
func TestAConnectionCopiedFromThePoolConfigSetsTheLimits(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg, err := newPoolConfig(srv.URL(), dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	copied := cfg.ConnConfig.Copy()
	if copied.AfterConnect == nil {
		t.Fatal("the copied connection config has no AfterConnect")
	}
}

func TestPoolSizeComesFromTheEnvironment(t *testing.T) {
	t.Setenv(envPoolMaxConns, "25")
	cfg, err := newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 25 {
		t.Fatalf("MaxConns = %d, want 25", cfg.MaxConns)
	}
}
