package repository

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs the statements against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (as services/pkg/dbmigrate; skipped
// when unset): a throwaway database migrated with the real migrations, dropped after.
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
	name := fmt.Sprintf("session_repo_test_%d", time.Now().UnixNano())
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

func rowsOf(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// seedConversation writes a conversation with a message, its context and one approval per status given.
func seedConversation(t *testing.T, repo *Repository, id string, statuses ...string) {
	t.Helper()
	ctx := context.Background()
	if _, err := repo.CreateSession(ctx, id, "u1", "self", id); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMessage(ctx, id, "user", "scale web to 3", nil, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i, status := range statuses {
		if _, err := repo.pool.Exec(ctx,
			`INSERT INTO tool_approvals (id, session_id, user_id, user_email, cluster, tool, args, status, created_at, expires_at, decided_at)
			 VALUES ($1, $2, 'u1', 'u1@example.com', 'self', 'k8s_scale_deployment', '{}', $3, $4, $5, $6)`,
			fmt.Sprintf("%s-%d", id, i), id, status, now, now.Add(10*time.Minute), now); err != nil {
			t.Fatalf("approval %s: %v", status, err)
		}
	}
}

// A conversation that showed approval cards is deleted with them; another conversation's stay.
func TestPostgresDeleteSessionTakesItsToolApprovals(t *testing.T) {
	pool := freshMigratedDatabase(t)
	repo := New(pool)
	ctx := context.Background()
	seedConversation(t, repo, "s-cards", "executed", "rejected", "expired", "pending")
	seedConversation(t, repo, "s-other", "pending")
	seedConversation(t, repo, "s-plain")

	for _, id := range []string{"s-cards", "s-plain"} {
		if err := repo.DeleteSession(ctx, id); err != nil {
			t.Fatalf("delete %s: %v", id, err)
		}
	}

	for _, table := range []string{"sessions", "messages", "session_contexts", "tool_approvals"} {
		column := "session_id"
		if table == "sessions" {
			column = "id"
		}
		if n := rowsOf(t, pool, `SELECT count(*) FROM `+table+` WHERE `+column+` <> 's-other'`); n != 0 {
			t.Errorf("%s: %d rows of the deleted conversations left", table, n)
		}
		if n := rowsOf(t, pool, `SELECT count(*) FROM `+table+` WHERE `+column+` = 's-other'`); n != 1 {
			t.Errorf("%s: %d rows of the conversation kept, want 1", table, n)
		}
	}
}
