package main

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// O-27: the pool set no session limits (PostgreSQL's default is 0, no limit for each).

func TestPoolConfigCarriesTheSessionLimits(t *testing.T) {
	const url = "postgres://kubeast:pw@db.example:5432/kubeast"
	cfg, err := newPoolConfig(url, dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	want := map[string]string{
		"statement_timeout":                   "30000",
		"lock_timeout":                        "15000",
		"idle_in_transaction_session_timeout": "300000",
	}
	for k, v := range want {
		if got := cfg.ConnConfig.RuntimeParams[k]; got != v {
			t.Fatalf("RuntimeParams[%s] = %q, want %q", k, got, v)
		}
	}
	plain, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	if cfg.MaxConns != plain.MaxConns || cfg.MinConns != plain.MinConns {
		t.Fatalf("MaxConns, MinConns = %d, %d, want pgxpool's %d, %d", cfg.MaxConns, cfg.MinConns, plain.MaxConns, plain.MinConns)
	}
}
