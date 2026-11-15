package dbsession

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// These tests send the limits to a PostgreSQL server named by DBMIGRATE_TEST_DATABASE_URL (the dbmigrate tests'
// server; no table is made) and skip when it is unset.

const advisoryTestKey int64 = 7_432_119_900

func connectWith(t *testing.T, apply func(*pgconn.Config)) *pgx.Conn {
	t.Helper()
	return connectAs(t, "", "", apply)
}

// connectAs is connectWith signed in as user with password; an empty user keeps the URL's.
func connectAs(t *testing.T, user, password string, apply func(*pgconn.Config)) *pgx.Conn {
	t.Helper()
	raw := os.Getenv("DBMIGRATE_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")
	}
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	if user != "" {
		cfg.User, cfg.Password = user, password
	}
	if apply != nil {
		apply(&cfg.Config)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func show(t *testing.T, conn *pgx.Conn, name string) string {
	t.Helper()
	var v string
	if err := conn.QueryRow(context.Background(), "SHOW "+name).Scan(&v); err != nil {
		t.Fatalf("SHOW %s: %v", name, err)
	}
	return v
}

func pgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func TestPostgres_TheDefaultsReachTheSession(t *testing.T) {
	conn := connectWith(t, Defaults.Apply)
	for name, want := range map[string]string{
		ParamStatementTimeout:  "30s",
		ParamLockTimeout:       "15s",
		ParamIdleInTransaction: "5min",
	} {
		if got := show(t, conn, name); got != want {
			t.Fatalf("SHOW %s = %q, want %q", name, got, want)
		}
	}
}

func TestPostgres_AStatementPastItsLimitIsCancelledByTheServer(t *testing.T) {
	conn := connectWith(t, Limits{StatementTimeout: 200 * time.Millisecond}.Apply)
	start := time.Now()
	_, err := conn.Exec(context.Background(), "SELECT pg_sleep(5)")
	if code := pgCode(err); code != "57014" {
		t.Fatalf("pg_sleep(5) with a 200 ms limit = %v, want query_canceled (57014)", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the statement ran %v", took)
	}
}

func TestPostgres_ALockWaitPastItsLimitFails(t *testing.T) {
	ctx := context.Background()
	holder := connectWith(t, nil)
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", advisoryTestKey); err != nil {
		t.Fatalf("holder lock: %v", err)
	}

	waiter := connectWith(t, Limits{LockTimeout: 200 * time.Millisecond}.Apply)
	start := time.Now()
	wtx, err := waiter.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer wtx.Rollback(ctx)
	_, err = wtx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", advisoryTestKey)
	if code := pgCode(err); code != "55P03" {
		t.Fatalf("waiting for a held lock with a 200 ms limit = %v, want lock_not_available (55P03)", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the wait ran %v", took)
	}
}

func TestPostgres_ATransactionLeftIdleIsEnded(t *testing.T) {
	ctx := context.Background()
	conn := connectWith(t, Limits{IdleInTransaction: 200 * time.Millisecond}.Apply)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, "SELECT 1"); err != nil {
		t.Fatalf("select: %v", err)
	}
	time.Sleep(800 * time.Millisecond)
	if _, err := tx.Exec(ctx, "SELECT 1"); err == nil {
		t.Fatal("a transaction idle past its 200 ms limit still answers")
	}
	_ = tx.Rollback(ctx)
}

// The audit sinks hold a session advisory lock on a connection that stays idle outside a transaction: the
// limits leave it, and its lock, alone.
func TestPostgres_AnIdleConnectionHoldingASessionLockKeepsIt(t *testing.T) {
	ctx := context.Background()
	holder := connectWith(t, Limits{StatementTimeout: 200 * time.Millisecond, LockTimeout: 200 * time.Millisecond, IdleInTransaction: 200 * time.Millisecond}.Apply)
	var ok bool
	if err := holder.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", advisoryTestKey).Scan(&ok); err != nil || !ok {
		t.Fatalf("pg_try_advisory_lock = %v, %v", ok, err)
	}
	t.Cleanup(func() { _, _ = holder.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", advisoryTestKey) })
	time.Sleep(800 * time.Millisecond)
	if err := holder.Ping(ctx); err != nil {
		t.Fatalf("the lock's connection after 800 ms idle: %v", err)
	}
	other := connectWith(t, nil)
	if err := other.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", advisoryTestKey).Scan(&ok); err != nil {
		t.Fatalf("other try: %v", err)
	}
	if ok {
		t.Fatal("another session took the lock: the idle holder lost it")
	}
}

func TestPostgres_MigrationConnectionsHaveNoStatementOrLockLimit(t *testing.T) {
	conn := connectWith(t, Limits{StatementTimeout: 200 * time.Millisecond, LockTimeout: 100 * time.Millisecond, IdleInTransaction: time.Minute}.ApplyMigrations)
	if got := show(t, conn, ParamStatementTimeout); got != "0" {
		t.Fatalf("SHOW statement_timeout = %q, want 0", got)
	}
	if got := show(t, conn, ParamLockTimeout); got != "0" {
		t.Fatalf("SHOW lock_timeout = %q, want 0", got)
	}
	if got := show(t, conn, ParamIdleInTransaction); got != "1min" {
		t.Fatalf("SHOW idle_in_transaction_session_timeout = %q, want 1min", got)
	}
	if _, err := conn.Exec(context.Background(), "SELECT pg_sleep(0.5)"); err != nil {
		t.Fatalf("pg_sleep(0.5) past the request limit: %v", err)
	}
}

// The RDS Proxy advice: the variables at 0 and the limits on the database role. The migration connections still run
// without the role's statement and lock limits, while a connection of the services keeps them.
func TestPostgres_MigrationConnectionsLiftTheRolesLimits(t *testing.T) {
	ctx := context.Background()
	const role, password = "kubeast_dbsession_role_limits", "dbsession-test"
	admin := connectWith(t, nil)
	for _, stmt := range []string{
		"DROP ROLE IF EXISTS " + role,
		"CREATE ROLE " + role + " LOGIN PASSWORD '" + password + "'",
		"ALTER ROLE " + role + " SET statement_timeout = '200ms'",
		"ALTER ROLE " + role + " SET lock_timeout = '100ms'",
	} {
		if _, err := admin.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP ROLE IF EXISTS "+role) })

	plain := connectAs(t, role, password, Limits{}.Apply)
	if got := show(t, plain, ParamStatementTimeout); got != "200ms" {
		t.Fatalf("SHOW statement_timeout as the role = %q, want the role's 200ms", got)
	}
	_ = plain.Close(ctx)

	mig := connectAs(t, role, password, Limits{}.ApplyMigrations)
	if got := show(t, mig, ParamStatementTimeout); got != "0" {
		t.Fatalf("SHOW statement_timeout on a migration connection = %q, want 0", got)
	}
	if got := show(t, mig, ParamLockTimeout); got != "0" {
		t.Fatalf("SHOW lock_timeout on a migration connection = %q, want 0", got)
	}
	if _, err := mig.Exec(ctx, "SELECT pg_sleep(0.5)"); err != nil {
		t.Fatalf("pg_sleep(0.5) past the role's 200 ms: %v", err)
	}
	_ = mig.Close(ctx)
}
