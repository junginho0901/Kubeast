package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
	"github.com/junginho0901/kubeast/services/pkg/dbsession/dbsessiontest"
)

// O-27: the pool set no session limits (PostgreSQL's default is 0, no limit for each). They are SET once a
// connection is made, not sent in the startup message.

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
	for _, s := range srv.Startups() {
		if v, ok := s["statement_timeout"]; ok {
			t.Fatalf("startup message holds statement_timeout=%q", v)
		}
	}
}

func TestPoolSizeComesFromTheEnvironment(t *testing.T) {
	t.Setenv(envPoolMaxConns, "8")
	cfg, err := newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Limits{})
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 8 || cfg.MinConns != 2 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 8, 2", cfg.MaxConns, cfg.MinConns)
	}
	if cfg.ConnConfig.AfterConnect != nil {
		t.Fatal("AfterConnect set with every limit 0")
	}
}
