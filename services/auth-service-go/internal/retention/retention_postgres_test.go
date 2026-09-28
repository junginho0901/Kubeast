package retention

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs the real purge against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL
// (same variable as services/pkg/dbmigrate; skipped when unset). A throwaway
// database is created, migrated with the real migrations, seeded with old and
// recent rows, purged, and dropped.
const testDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

func freshMigratedDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv(testDatabaseURLEnv)
	if raw == "" {
		t.Skipf("%s not set: needs a PostgreSQL server", testDatabaseURLEnv)
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	name := fmt.Sprintf("retention_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return pool
}

func count(t *testing.T, pool *pgxpool.Pool, table string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPostgresPurgeDeletesOnlyExpiredRows(t *testing.T) {
	pool := freshMigratedDatabase(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	old := now.AddDate(0, 0, -400)    // beyond both windows
	middle := now.AddDate(0, 0, -200) // beyond chat (180), within audit (365)
	recent := now.AddDate(0, 0, -10)  // within both

	// One statement per Exec: the extended protocol does not take several
	// parameterised statements in one call.
	seed := []string{
		`INSERT INTO auth_users (id, name, email, password_hash) VALUES ('u1', 'U', 'u1@example.com', 'x')`,
		`INSERT INTO auth_audit_logs (service, action, created_at) VALUES
		   ('auth', 'user.login.success', $1), ('auth', 'user.login.success', $2), ('auth', 'user.login.success', $3)`,
		`INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES
		   ('s-old', 'u1', 'old', $1, $1), ('s-mid', 'u1', 'mid', $2, $2), ('s-new', 'u1', 'new', $3, $3)`,
		`INSERT INTO messages (session_id, role, content, created_at) VALUES
		   ('s-old', 'user', 'a', $1), ('s-mid', 'user', 'b', $2), ('s-new', 'user', 'c', $3)`,
		`INSERT INTO session_contexts (session_id, state, cache, updated_at) VALUES
		   ('s-old', '{}', '{}', $1), ('s-mid', '{}', '{}', $2), ('s-new', '{}', '{}', $3)`,
		`INSERT INTO tool_approvals (id, session_id, user_id, user_email, cluster, tool, args, status, created_at, expires_at) VALUES
		   ('t-old', 's-old', 'u1', 'u1@example.com', 'self', 'k8s_scale', '{}', 'approved', $1, $1),
		   ('t-mid-in-new', 's-new', 'u1', 'u1@example.com', 'self', 'k8s_scale', '{}', 'approved', $2, $2),
		   ('t-new', 's-new', 'u1', 'u1@example.com', 'self', 'k8s_scale', '{}', 'pending', $3, $3)`,
	}
	for _, stmt := range seed {
		args := []any{old, middle, recent}
		if !strings.Contains(stmt, "$1") {
			args = nil
		}
		if _, err := pool.Exec(ctx, stmt, args...); err != nil {
			t.Fatalf("seed %q: %v", stmt[:40], err)
		}
	}

	res, err := Purger{Pool: pool, Cfg: Config{AuditDays: 365, ChatDays: 180}}.Purge(ctx, now)
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	// audit: only the 400-day row; chat: s-old and s-mid (with their messages,
	// contexts); tool approvals: t-old (by age and by session), t-mid-in-new (by age).
	if res.AuditRows != 1 || res.Sessions != 2 || res.ToolApprovals != 2 {
		t.Fatalf("result = %+v, want audit 1, sessions 2, tool_approvals 2", res)
	}
	if n := count(t, pool, "auth_audit_logs"); n != 2 {
		t.Fatalf("audit rows left = %d, want 2", n)
	}
	if n := count(t, pool, "sessions"); n != 1 {
		t.Fatalf("sessions left = %d, want 1", n)
	}
	if n := count(t, pool, "messages"); n != 1 {
		t.Fatalf("messages left = %d (cascade), want 1", n)
	}
	if n := count(t, pool, "session_contexts"); n != 1 {
		t.Fatalf("session_contexts left = %d (cascade), want 1", n)
	}
	if n := count(t, pool, "tool_approvals"); n != 1 {
		t.Fatalf("tool_approvals left = %d, want 1", n)
	}
	var left string
	if err := pool.QueryRow(ctx, "SELECT id FROM sessions").Scan(&left); err != nil || left != "s-new" {
		t.Fatalf("remaining session = %q, %v", left, err)
	}

	// A second run finds nothing.
	again, err := Purger{Pool: pool, Cfg: Config{AuditDays: 365, ChatDays: 180}}.Purge(ctx, now)
	if err != nil || again != (Result{}) {
		t.Fatalf("second purge = %+v, %v; want zero", again, err)
	}
}

func TestPostgresPurgeBatches(t *testing.T) {
	pool := freshMigratedDatabase(t)
	ctx := context.Background()
	now := time.Now()
	total := BatchSize*2 + 7
	if _, err := pool.Exec(ctx,
		`INSERT INTO auth_audit_logs (service, action, created_at) SELECT 'auth', 'x', $1 FROM generate_series(1, $2)`,
		now.AddDate(0, 0, -400), total); err != nil {
		t.Fatal(err)
	}
	res, err := Purger{Pool: pool, Cfg: Config{AuditDays: 365}}.Purge(ctx, now)
	if err != nil || res.AuditRows != int64(total) {
		t.Fatalf("batched purge = %+v, %v; want %d rows", res, err, total)
	}
	if n := count(t, pool, "auth_audit_logs"); n != 0 {
		t.Fatalf("rows left = %d", n)
	}
}
