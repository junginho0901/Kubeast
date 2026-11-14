package main

import (
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// O-27: no pool set statement_timeout, lock_timeout or idle_in_transaction_session_timeout (PostgreSQL's default for
// each is 0, no limit), so a statement that did not end or a transaction left open held its locks and a connection
// of the 20 until the pod went.

const poolTestURL = "postgres://kubeast:pw@db.example:5432/kubeast"

func TestPoolConfigCarriesTheSessionLimits(t *testing.T) {
	cfg, err := newPoolConfig(poolTestURL, dbsession.Defaults)
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

func TestPoolConfigTakesTheLimitsFromTheEnvironment(t *testing.T) {
	t.Setenv(dbsession.EnvStatementTimeout, "45000")
	t.Setenv(dbsession.EnvLockTimeout, "0")
	t.Setenv(dbsession.EnvIdleInTransaction, "")
	cfg, err := newPoolConfig(poolTestURL, dbsession.FromEnv())
	if err != nil {
		t.Fatalf("newPoolConfig: %v", err)
	}
	if got := cfg.ConnConfig.RuntimeParams["statement_timeout"]; got != "45000" {
		t.Fatalf("statement_timeout = %q, want 45000", got)
	}
	if got, ok := cfg.ConnConfig.RuntimeParams["lock_timeout"]; ok {
		t.Fatalf("lock_timeout = %q with DB_LOCK_TIMEOUT_MS=0, want it not sent", got)
	}
	if got := cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"]; got != "300000" {
		t.Fatalf("idle_in_transaction_session_timeout = %q, want the default 300000", got)
	}
}

func TestMigrationPoolHasNoStatementOrLockLimit(t *testing.T) {
	cfg, err := newMigrationPoolConfig(poolTestURL, dbsession.Defaults)
	if err != nil {
		t.Fatalf("newMigrationPoolConfig: %v", err)
	}
	want := map[string]string{
		"statement_timeout":                   "0",
		"lock_timeout":                        "0",
		"idle_in_transaction_session_timeout": "300000",
	}
	for k, v := range want {
		if got := cfg.ConnConfig.RuntimeParams[k]; got != v {
			t.Fatalf("migration RuntimeParams[%s] = %q, want %q", k, got, v)
		}
	}
}
