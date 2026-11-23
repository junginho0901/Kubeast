package repository

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
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
		if _, err := repo.DeleteSession(ctx, id); err != nil {
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

// The delete returns the approvals it took while approved, with their tool, cluster and approval time; those in
// another state, and another conversation's approved one, are not named.
func TestPostgresDeleteSessionNamesTheApprovalsItTookWhileApproved(t *testing.T) {
	pool := freshMigratedDatabase(t)
	repo := New(pool)
	ctx := context.Background()
	before := time.Now().UTC().Add(-time.Second)
	seedConversation(t, repo, "s-run", "executed", "approved", "rejected", "pending", "approved")
	seedConversation(t, repo, "s-other", "approved")

	open, err := repo.DeleteSession(ctx, "s-run")
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 2 {
		t.Fatalf("named %+v, want s-run-1 and s-run-4", open)
	}
	slices.SortFunc(open, func(a, b model.OpenApproval) int { return strings.Compare(a.ID, b.ID) })
	for i, id := range []string{"s-run-1", "s-run-4"} {
		a := open[i]
		if a.ID != id || a.Tool != "k8s_scale_deployment" || a.Cluster != "self" || a.ApprovedAt == nil ||
			a.ApprovedAt.Before(before) || a.ApprovedAt.After(time.Now().UTC()) {
			t.Errorf("named %+v, want %s with its tool, cluster and approval time", a, id)
		}
	}
	if n := rowsOf(t, pool, `SELECT count(*) FROM tool_approvals WHERE session_id = 's-other' AND status = 'approved'`); n != 1 {
		t.Errorf("another conversation's approved approval: %d left, want 1", n)
	}

	none, err := repo.DeleteSession(ctx, "s-other-gone")
	if err != nil || none != nil {
		t.Fatalf("a conversation that is not there: %+v, %v", none, err)
	}
}

// A write to an approval that commits while the delete waits for its row decides what the delete names: an outcome
// written then is not named, and an approval made then is.
func TestPostgresDeleteSessionNamesTheApprovalAsTheWriteItWaitedForLeftIt(t *testing.T) {
	for _, c := range []struct {
		from, to string
		named    int
	}{{"approved", "executed", 0}, {"pending", "approved", 1}} {
		t.Run(c.from+"-to-"+c.to, func(t *testing.T) {
			pool := freshMigratedDatabase(t)
			repo := New(pool)
			ctx := context.Background()
			seedConversation(t, repo, "s-run", c.from)

			run, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer run.Rollback(ctx)
			if _, err := run.Exec(ctx, `UPDATE tool_approvals SET status = $1 WHERE id = 's-run-0'`, c.to); err != nil {
				t.Fatal(err)
			}

			type answer struct {
				open []model.OpenApproval
				err  error
			}
			done := make(chan answer, 1)
			go func() {
				open, err := repo.DeleteSession(ctx, "s-run")
				done <- answer{open, err}
			}()
			deadline := time.Now().Add(10 * time.Second)
			for rowsOf(t, pool, `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'DELETE FROM tool_approvals%'`) == 0 {
				if time.Now().After(deadline) {
					t.Fatal("the delete never waited for the row")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := run.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			got := <-done
			if got.err != nil || len(got.open) != c.named {
				t.Fatalf("named %+v (%v), want %d", got.open, got.err, c.named)
			}
		})
	}
}
