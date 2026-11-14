package main

import (
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// O-27: the pool set no session limits (PostgreSQL's default is 0, no limit for each).

func TestPoolConfigCarriesTheSessionLimits(t *testing.T) {
	cfg, err := newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Defaults)
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if cfg.MaxConns != 20 || cfg.MinConns != 2 {
		t.Fatalf("MaxConns, MinConns = %d, %d, want 20, 2", cfg.MaxConns, cfg.MinConns)
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
}

func TestPoolConfigSendsNoLimitSetToZero(t *testing.T) {
	cfg, err := newPoolConfig("postgres://kubeast:pw@db.example:5432/kubeast", dbsession.Limits{})
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	for _, k := range []string{"statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"} {
		if v, ok := cfg.ConnConfig.RuntimeParams[k]; ok {
			t.Fatalf("RuntimeParams[%s] = %q with every limit 0, want it not sent", k, v)
		}
	}
}
