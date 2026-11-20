package dbmigrate

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// After Up, the statements that run on every new approval card and on a chat's delete read tool_approvals through
// the indexes of 00032, not the whole table: 3 000 decided rows, 4 waiting and 2 approved, as an install keeps them
// with retention.chatDays 0. The SQL is what ai-service (app/database.py, SQLAlchemy) and session-service
// (DeleteSession) send.
func TestPostgresToolApprovalQueriesUseTheirIndexes(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	if _, err := Up(ctx, pool); err != nil {
		t.Fatalf("Up: %v", err)
	}
	for _, seed := range []string{
		`INSERT INTO sessions (id, user_id, title) SELECT 's-' || g, 'u-' || (g % 20), 'chat' FROM generate_series(1, 500) g`,
		`INSERT INTO tool_approvals (id, session_id, user_id, cluster, tool, args, status, created_at, expires_at, decided_at)
		 SELECT 'd-' || g, 's-' || (1 + g % 500), 'u-' || (g % 20), 'c', 'scale_deployment', '{"name": "web"}',
		        (ARRAY['executed', 'executed', 'executed', 'rejected', 'expired', 'failed'])[1 + g % 6],
		        localtimestamp - g * interval '1 hour', localtimestamp - g * interval '1 hour' + interval '600 seconds',
		        localtimestamp - g * interval '1 hour' + interval '30 seconds'
		 FROM generate_series(1, 3000) g`,
		`INSERT INTO tool_approvals (id, session_id, user_id, cluster, tool, args, status, created_at, expires_at)
		 SELECT 'p-' || g, 's-' || g, 'u-' || (g % 20), 'c', 'scale_deployment', '{}', 'pending',
		        localtimestamp - g * interval '5 minutes', localtimestamp - g * interval '5 minutes' + interval '600 seconds'
		 FROM generate_series(1, 4) g`,
		`INSERT INTO tool_approvals (id, session_id, user_id, cluster, tool, args, status, created_at, expires_at, decided_at)
		 SELECT 'a-' || g, 's-' || g, 'u-' || (g % 20), 'c', 'scale_deployment', '{}', 'approved',
		        localtimestamp - g * interval '1 hour', localtimestamp, localtimestamp - g * interval '50 minutes'
		 FROM generate_series(1, 2) g`,
		`ANALYZE sessions`,
		`ANALYZE tool_approvals`,
	} {
		if _, err := pool.Exec(ctx, seed); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	for _, c := range []struct {
		name, sql, arg, index string
	}{
		{"waiting calls past their time, before each new card (_expire_waiting_tool_approvals)",
			`SELECT * FROM tool_approvals WHERE tool_approvals.status = $1::VARCHAR AND tool_approvals.expires_at < localtimestamp LIMIT 50`,
			"pending", "idx_tool_approvals_status_decided_at"},
		{"approved runs that never wrote their outcome, before each new card (close_interrupted_tool_approvals)",
			`SELECT * FROM tool_approvals WHERE tool_approvals.status = $1::VARCHAR AND tool_approvals.decided_at < localtimestamp - interval '600 seconds' ORDER BY tool_approvals.decided_at LIMIT 50`,
			"approved", "idx_tool_approvals_status_decided_at"},
		{"a chat's waiting cards (list_tool_approvals)",
			`SELECT * FROM tool_approvals WHERE tool_approvals.session_id = 's-3' AND tool_approvals.user_id = 'u-3' AND tool_approvals.status = $1::VARCHAR ORDER BY tool_approvals.created_at`,
			"pending", "idx_tool_approvals_session_id"},
		{"a chat's delete (session-service DeleteSession)",
			`DELETE FROM tool_approvals WHERE session_id = $1`,
			"s-7", "idx_tool_approvals_session_id"},
	} {
		plan := explain(t, ctx, pool, c.sql, c.arg)
		if !strings.Contains(plan, c.index) || strings.Contains(plan, "Seq Scan on tool_approvals") {
			t.Errorf("%s: want a read through %s, not the whole table; plan:\n%s", c.name, c.index, plan)
		}
	}
}

// explain returns the plan the server makes for sql with its one parameter bound (EXPLAIN without ANALYZE, so a
// DELETE deletes nothing).
func explain(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql, arg string) string {
	t.Helper()
	rows, err := pool.Query(ctx, "EXPLAIN "+sql, arg)
	if err != nil {
		t.Fatalf("EXPLAIN %s: %v", sql, err)
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(lines, "\n")
}
