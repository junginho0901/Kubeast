package dbmigrate

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests run the real migrations against a PostgreSQL server named by
// DBMIGRATE_TEST_DATABASE_URL (a superuser or CREATEDB role, e.g.
// postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable). Each
// test creates its own database and drops it afterwards; they are skipped when
// the variable is unset so `go test ./...` stays runnable without a server.
const testDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

// expectedTables is every table the baseline creates (the ai-service, auth,
// session, k8s and controller tables) — the list the services relied on the
// old per-service CREATE TABLE code for.
var expectedTables = []string{
	"access_requests", "api_keys", "audit_sink_cursors", "auth_audit_logs", "auth_users", "cluster_setup", "clusters", "messages",
	"model_configs", "organizations", "role_permissions", "roles", "session_contexts", "session_recording_parts", "session_recordings",
	"sessions", "tool_approvals", "user_cluster_roles",
}

func freshDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv(testDatabaseURLEnv)
	if raw == "" {
		t.Skipf("%s not set: needs a PostgreSQL server", testDatabaseURLEnv)
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatalf("connect to %s: %v", testDatabaseURLEnv, err)
	}
	name := fmt.Sprintf("dbmigrate_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
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
	return pool
}

func publicTables(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func TestPostgresUpFromEmptyDatabase(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()

	v, err := Up(ctx, pool)
	if err != nil {
		t.Fatalf("Up: %v", err)
	}
	if v != Required {
		t.Fatalf("Up reported version %d, Required is %d", v, Required)
	}
	if got, err := Version(ctx, pool); err != nil || got != Required {
		t.Fatalf("Version = %d, %v; want %d", got, err, Required)
	}

	want := append([]string{}, expectedTables...)
	want = append(want, versionTable)
	sort.Strings(want)
	if got := publicTables(t, pool); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("tables after Up:\n got  %v\n want %v", got, want)
	}

	// auth_users is created in its final shape: role_id present, no legacy role.
	var hasRole, hasRoleID bool
	if err := pool.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'role'),
		EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'role_id')`,
	).Scan(&hasRole, &hasRoleID); err != nil {
		t.Fatal(err)
	}
	if hasRole || !hasRoleID {
		t.Fatalf("auth_users columns: role=%v role_id=%v; want role absent, role_id present", hasRole, hasRoleID)
	}

	// Running again applies nothing and keeps the version.
	if again, err := Up(ctx, pool); err != nil || again != Required {
		t.Fatalf("second Up = %d, %v; want %d, nil", again, err, Required)
	}

	if err := WaitFor(ctx, pool, Required, 2*time.Second); err != nil {
		t.Fatalf("WaitFor(Required) on a migrated database: %v", err)
	}
	err = WaitFor(ctx, pool, Required+1, time.Second)
	if !errors.Is(err, ErrBehind) {
		t.Fatalf("WaitFor(Required+1) = %v; want ErrBehind", err)
	}
}

func TestPostgresLegacyRoleColumnIsConverted(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()

	// The shape the pre-migration auth-service created: a role string, no role_id.
	legacy := `
CREATE TABLE auth_users (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    email VARCHAR NOT NULL UNIQUE,
    hq VARCHAR,
    role VARCHAR NOT NULL DEFAULT 'pending',
    password_hash VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO auth_users (id, name, email, role, password_hash) VALUES
    ('u-admin', 'Admin', 'admin@example.com', 'admin', 'x'),
    ('u-read',  'Reader', 'reader@example.com', 'read', 'x'),
    ('u-odd',   'Odd', 'odd@example.com', 'something-unknown', 'x');`
	if _, err := pool.Exec(ctx, legacy); err != nil {
		t.Fatalf("legacy schema: %v", err)
	}

	if v, err := Up(ctx, pool); err != nil || v != Required {
		t.Fatalf("Up on legacy database = %d, %v; want %d, nil", v, err, Required)
	}

	var hasRole, hasHQ bool
	var roleIDNullable string
	if err := pool.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'role'),
		EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'hq'),
		(SELECT is_nullable FROM information_schema.columns WHERE table_name = 'auth_users' AND column_name = 'role_id')`,
	).Scan(&hasRole, &hasHQ, &roleIDNullable); err != nil {
		t.Fatal(err)
	}
	if hasRole || hasHQ || roleIDNullable != "NO" {
		t.Fatalf("after Up: role present=%v hq present=%v role_id nullable=%s; want false, false, NO", hasRole, hasHQ, roleIDNullable)
	}

	rows, err := pool.Query(ctx, `SELECT u.id, r.name FROM auth_users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			t.Fatal(err)
		}
		got[id] = role
	}
	want := map[string]string{"u-admin": "Admin", "u-read": "Read", "u-odd": "Read"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("role mapping after conversion: got %v want %v", got, want)
	}
}
