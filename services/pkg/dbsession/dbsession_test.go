package dbsession

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/junginho0901/kubeast/services/pkg/dbsession/dbsessiontest"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{EnvStatementTimeout, EnvLockTimeout, EnvIdleInTransaction} {
		t.Setenv(k, "")
	}
}

func connect(t *testing.T, cfg *pgconn.Config) (*pgconn.PgConn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err == nil {
		t.Cleanup(func() { _ = conn.Close(context.Background()) })
	}
	return conn, err
}

func parse(t *testing.T, url string) *pgconn.Config {
	t.Helper()
	cfg, err := pgconn.ParseConfig(url)
	if err != nil {
		t.Fatalf("ParseConfig(%q): %v", url, err)
	}
	return cfg
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

func TestPoolMaxConnsTakesAWholeNumberOfOneOrMore(t *testing.T) {
	const key = "DB_POOL_MAX_TEST"
	for v, want := range map[string]int32{"": 7, "12": 12, "1": 1, "0": 7, "-3": 7, "2.5": 7, "abc": 7, "20000": 7} {
		t.Setenv(key, v)
		if got := PoolMaxConns(key, 7); got != want {
			t.Fatalf("%s=%q gives %d, want %d", key, v, got, want)
		}
	}
}

func TestStatementsSetEachLimitInMilliseconds(t *testing.T) {
	want := "SET statement_timeout = 30000; SET lock_timeout = 15000; SET idle_in_transaction_session_timeout = 300000"
	if got := Defaults.Statements(); got != want {
		t.Fatalf("Statements() = %q, want %q", got, want)
	}
	if got := (Limits{IdleInTransaction: time.Minute}).Statements(); got != "SET idle_in_transaction_session_timeout = 60000" {
		t.Fatalf("Statements() with two limits 0 = %q", got)
	}
	if got := (Limits{}).Statements(); got != "" {
		t.Fatalf("Statements() with every limit 0 = %q, want none", got)
	}
}

func TestMigrationStatementsHaveNoStatementOrLockLimit(t *testing.T) {
	want := "SET statement_timeout = 0; SET lock_timeout = 0; SET idle_in_transaction_session_timeout = 300000"
	if got := Defaults.MigrationStatements(); got != want {
		t.Fatalf("MigrationStatements() = %q, want %q", got, want)
	}
	// Every variable at 0 (the limits on the role, behind RDS Proxy): the migrations still lift the role's limits.
	if got, want := (Limits{}).MigrationStatements(), "SET statement_timeout = 0; SET lock_timeout = 0"; got != want {
		t.Fatalf("MigrationStatements() with every limit 0 = %q, want %q", got, want)
	}
}

// O-27: the limits go in SET statements after the connection is made, not in the startup message, which a pooler such
// as PgBouncer refuses by default when it holds parameters it does not know.
func TestApplySetsTheLimitsAfterConnectingNotInTheStartupMessage(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg := parse(t, srv.URL())
	Defaults.Apply(cfg)
	if _, err := connect(t, cfg); err != nil {
		t.Fatalf("connect: %v", err)
	}
	startups := srv.Startups()
	if len(startups) != 1 {
		t.Fatalf("%d startup messages, want 1", len(startups))
	}
	for _, p := range []string{ParamStatementTimeout, ParamLockTimeout, ParamIdleInTransaction, "options"} {
		if v, ok := startups[0][p]; ok {
			t.Fatalf("startup message holds %s=%q", p, v)
		}
	}
	if q := srv.Queries(); len(q) != 1 || q[0] != Defaults.Statements() {
		t.Fatalf("queries after connecting = %q, want [%q]", q, Defaults.Statements())
	}
}

func TestApplyMigrationsSetsNoStatementOrLockLimit(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg := parse(t, srv.URL())
	Defaults.ApplyMigrations(cfg)
	if _, err := connect(t, cfg); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if q := srv.Queries(); len(q) != 1 || q[0] != Defaults.MigrationStatements() {
		t.Fatalf("queries after connecting = %q, want [%q]", q, Defaults.MigrationStatements())
	}
}

func TestApplyRunsAfterAnEarlierAfterConnect(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg := parse(t, srv.URL())
	var order []string
	cfg.AfterConnect = func(ctx context.Context, conn *pgconn.PgConn) error {
		order = append(order, "earlier")
		_, err := conn.Exec(ctx, "SELECT 1").ReadAll()
		return err
	}
	Defaults.Apply(cfg)
	if _, err := connect(t, cfg); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if q := srv.Queries(); len(order) != 1 || len(q) != 2 || q[0] != "SELECT 1" || q[1] != Defaults.Statements() {
		t.Fatalf("earlier hook ran %d times, queries %q", len(order), q)
	}
}

func TestNoLimitsSendNothing(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg := parse(t, srv.URL())
	Limits{}.Apply(cfg)
	if cfg.AfterConnect != nil {
		t.Fatal("AfterConnect set with every limit 0")
	}
	if _, err := connect(t, cfg); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if q := srv.Queries(); len(q) != 0 {
		t.Fatalf("queries with every limit 0 = %q", q)
	}
}

// With every variable at 0 the limits may be on the role (behind RDS Proxy); the migration connections set the
// statement and lock limits to 0 all the same.
func TestApplyMigrationsWithEveryLimitZeroStillLiftsTheStatementAndLockLimits(t *testing.T) {
	srv := dbsessiontest.Start(t)
	cfg := parse(t, srv.URL())
	Limits{}.ApplyMigrations(cfg)
	if _, err := connect(t, cfg); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if q := srv.Queries(); len(q) != 1 || q[0] != "SET statement_timeout = 0; SET lock_timeout = 0" {
		t.Fatalf("queries after connecting = %q", q)
	}
}

func TestASetThatFailsFailsTheConnection(t *testing.T) {
	srv := dbsessiontest.Start(t)
	srv.Fail("SET statement_timeout")
	cfg := parse(t, srv.URL())
	Defaults.Apply(cfg)
	_, err := connect(t, cfg)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("connect with a refused SET = %v, want the server's error", err)
	}
}
