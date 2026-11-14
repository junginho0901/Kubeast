package dbsession

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const testURL = "postgres://kubeast:pw@db.example:5432/kubeast"

func parse(t *testing.T, url string) *pgconn.Config {
	t.Helper()
	cfg, err := pgconn.ParseConfig(url)
	if err != nil {
		t.Fatalf("ParseConfig(%q): %v", url, err)
	}
	return cfg
}

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{EnvStatementTimeout, EnvLockTimeout, EnvIdleInTransaction} {
		t.Setenv(k, "")
	}
}

func TestFromEnvWithNothingSetIsTheDefaults(t *testing.T) {
	clearEnv(t)
	if got := FromEnv(); got != Defaults {
		t.Fatalf("FromEnv() = %+v, want %+v", got, Defaults)
	}
	if Defaults.LockTimeout >= Defaults.StatementTimeout {
		t.Fatalf("lock limit %v is not below the statement limit %v, so it would never fire first", Defaults.LockTimeout, Defaults.StatementTimeout)
	}
}

func TestFromEnvReadsMillisecondsAndZero(t *testing.T) {
	clearEnv(t)
	t.Setenv(EnvStatementTimeout, "60000")
	t.Setenv(EnvLockTimeout, "0")
	t.Setenv(EnvIdleInTransaction, "120000")
	want := Limits{StatementTimeout: time.Minute, LockTimeout: 0, IdleInTransaction: 2 * time.Minute}
	if got := FromEnv(); got != want {
		t.Fatalf("FromEnv() = %+v, want %+v", got, want)
	}
}

func TestFromEnvKeepsTheDefaultForAnUnreadableValue(t *testing.T) {
	for _, v := range []string{"-1", "30s", "1.5", "abc"} {
		clearEnv(t)
		t.Setenv(EnvStatementTimeout, v)
		if got := FromEnv().StatementTimeout; got != Defaults.StatementTimeout {
			t.Fatalf("%s=%q gives %v, want the default %v", EnvStatementTimeout, v, got, Defaults.StatementTimeout)
		}
	}
}

func TestApplySendsEachLimitInMilliseconds(t *testing.T) {
	cfg := parse(t, testURL)
	Defaults.Apply(cfg)
	want := map[string]string{
		ParamStatementTimeout:  "30000",
		ParamLockTimeout:       "15000",
		ParamIdleInTransaction: "300000",
	}
	for k, v := range want {
		if cfg.RuntimeParams[k] != v {
			t.Fatalf("RuntimeParams[%s] = %q, want %q (all: %v)", k, cfg.RuntimeParams[k], v, cfg.RuntimeParams)
		}
	}
	if _, ok := cfg.RuntimeParams["idle_session_timeout"]; ok {
		t.Fatal("idle_session_timeout is set: it would close the connections that hold an advisory lock while idle")
	}
}

func TestApplyLeavesAZeroLimitToTheDatabaseOrTheURL(t *testing.T) {
	cfg := parse(t, testURL+"?statement_timeout=5000")
	Limits{IdleInTransaction: time.Minute}.Apply(cfg)
	if got := cfg.RuntimeParams[ParamStatementTimeout]; got != "5000" {
		t.Fatalf("statement_timeout from the URL = %q, want it kept as 5000", got)
	}
	if _, ok := cfg.RuntimeParams[ParamLockTimeout]; ok {
		t.Fatalf("lock_timeout sent for a zero limit: %v", cfg.RuntimeParams)
	}
	if got := cfg.RuntimeParams[ParamIdleInTransaction]; got != "60000" {
		t.Fatalf("idle_in_transaction_session_timeout = %q, want 60000", got)
	}

	cfg = parse(t, testURL+"?statement_timeout=5000")
	Defaults.Apply(cfg)
	if got := cfg.RuntimeParams[ParamStatementTimeout]; got != "30000" {
		t.Fatalf("a set limit over the URL's = %q, want 30000", got)
	}
}

func TestApplyMigrationsSendsNoStatementOrLockLimit(t *testing.T) {
	cfg := parse(t, testURL)
	Defaults.ApplyMigrations(cfg)
	want := map[string]string{
		ParamStatementTimeout:  "0",
		ParamLockTimeout:       "0",
		ParamIdleInTransaction: "300000",
	}
	for k, v := range want {
		if cfg.RuntimeParams[k] != v {
			t.Fatalf("RuntimeParams[%s] = %q, want %q (all: %v)", k, cfg.RuntimeParams[k], v, cfg.RuntimeParams)
		}
	}
}

func TestApplyMigrationsSendsNothingWhereTheLimitsSendNothing(t *testing.T) {
	cfg := parse(t, testURL)
	Limits{}.ApplyMigrations(cfg)
	for _, k := range []string{ParamStatementTimeout, ParamLockTimeout, ParamIdleInTransaction} {
		if v, ok := cfg.RuntimeParams[k]; ok {
			t.Fatalf("RuntimeParams[%s] = %q with every limit 0; a pooler that refuses unknown startup parameters would refuse it", k, v)
		}
	}
}

func TestApplyOnAConfigWithoutParams(t *testing.T) {
	cfg := &pgconn.Config{}
	Defaults.Apply(cfg)
	if cfg.RuntimeParams[ParamStatementTimeout] != "30000" {
		t.Fatalf("RuntimeParams = %v", cfg.RuntimeParams)
	}
}
