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

// Runs the AI-usage query against PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL
// (same variable as services/pkg/dbmigrate; skipped when unset): a throwaway
// database migrated with the real migrations, seeded, queried and dropped.
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
	name := fmt.Sprintf("ai_usage_test_%d", time.Now().UnixNano())
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

func TestPostgresAIUsage_501GroupsAndInvestigations(t *testing.T) {
	pool := freshMigratedDatabase(t)
	ctx := context.Background()
	at := time.Now().UTC().Add(-time.Hour)
	seed := []string{
		// 501 users, one turn each: user i spent 10000-i tokens, one tool call; user 000 also failed once without usage
		`INSERT INTO auth_audit_logs (service, action, actor_email, cluster, result, after, created_at)
		 SELECT 'ai', 'ai.chat.complete', format('u%s@example.com', lpad(i::text, 3, '0')), 'self', 'success',
		        jsonb_build_object('model', 'm1', 'cluster', 'self', 'prompt_tokens', 9990 - i, 'completion_tokens', 10,
		                           'total_tokens', 10000 - i, 'cached_tokens', 5, 'prompt_chars', 800, 'tool_calls', 1, 'duration_ms', 1000),
		        $1::timestamp
		   FROM generate_series(0, 500) AS i`,
		`INSERT INTO auth_audit_logs (service, action, actor_email, cluster, result, after, created_at) VALUES
		   ('ai', 'ai.chat.complete', 'u000@example.com', 'self', 'failure',
		    '{"model": "m1", "cluster": "self", "prompt_tokens": null, "completion_tokens": null, "total_tokens": null, "cached_tokens": null, "prompt_chars": 700, "tool_calls": 0, "duration_ms": 500}', $1)`,
		// two investigations by the investigator on model m1, cluster only in the column; one failed before any usage
		`INSERT INTO auth_audit_logs (service, action, actor_user_id, actor_email, cluster, result, after, created_at) VALUES
		   ('ai', 'ai.investigation.run', 'system', 'kubeast:investigator', 'default', 'success',
		    '{"model": "m1", "prompt_tokens": 300, "completion_tokens": 50, "total_tokens": 350, "tool_calls": 4, "duration_ms": 9000}', $1),
		   ('ai', 'ai.investigation.run', 'system', 'kubeast:investigator', 'default', 'failure',
		    '{"model": null, "prompt_tokens": null, "completion_tokens": null, "total_tokens": null, "tool_calls": 0, "duration_ms": 3000}', $1)`,
		// outside the period and another action: not counted
		`INSERT INTO auth_audit_logs (service, action, actor_email, after, created_at) VALUES
		   ('ai', 'ai.chat.complete', 'old@example.com', '{"total_tokens": 99}', $1::timestamp - interval '10 days'),
		   ('ai', 'ai.chat.summarize', 'u001@example.com', '{"prompt_tokens": 99}', $1)`,
	}
	for _, q := range seed {
		if _, err := pool.Exec(ctx, q, at); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	repo := New(pool)
	since, until := at.Add(-24*time.Hour), at.Add(time.Hour)

	var chatTokens int64
	for i := 0; i < 501; i++ {
		chatTokens += int64(10000 - i)
	}

	report, err := repo.AIUsage(ctx, since, until, "user", 500)
	if err != nil {
		t.Fatal(err)
	}
	chat, inv := report.Totals.Chat, report.Totals.Investigation
	if len(report.Rows) != 501 || chat.Rows != 500 || inv.Rows != 1 {
		t.Fatalf("rows %d (chat %d, investigation %d), want 501 (500, 1)", len(report.Rows), chat.Rows, inv.Rows)
	}
	if chat.Groups != 501 || !chat.Truncated || inv.Groups != 1 || inv.Truncated || !report.Truncated {
		t.Fatalf("chat %d groups truncated %v, investigation %d groups truncated %v", chat.Groups, chat.Truncated, inv.Groups, inv.Truncated)
	}
	if chat.TotalTokens != chatTokens || chat.Requests != 502 || chat.Failures != 1 || chat.TokenRequests != 501 || chat.ToolCalls != 501 {
		t.Fatalf("chat totals %+v, want tokens %d requests 502 failures 1 token requests 501 tool calls 501", chat, chatTokens)
	}
	if inv.TotalTokens != 350 || inv.Requests != 2 || inv.Failures != 1 || inv.TokenRequests != 1 || inv.ToolCalls != 4 {
		t.Fatalf("investigation totals %+v", inv)
	}
	if report.Totals.All.TotalTokens != chatTokens+350 || report.Totals.All.Groups != 502 {
		t.Fatalf("all totals %+v", report.Totals.All)
	}
	// most tokens first; the 501st user (u500, 9500 tokens) is the one cut; the investigator ranks by its own tokens
	if r := report.Rows[0]; r.Source != AIUsageChat || r.Key != "u000@example.com" || r.Requests != 2 || r.TokenRequests != 1 || *r.CachedTokens != 5 {
		t.Fatalf("first row %+v", r)
	}
	last := report.Rows[len(report.Rows)-1]
	if last.Source != AIUsageInvestigation || last.Key != "kubeast:investigator" || last.TotalTokens != 350 || last.CachedTokens != nil || last.PromptChars != nil {
		t.Fatalf("last row %+v", last)
	}
	for _, r := range report.Rows {
		if r.Key == "u500@example.com" {
			t.Fatalf("u500 is past the limit")
		}
	}

	// the limit is an argument; the totals do not change with it
	small, err := repo.AIUsage(ctx, since, until, "user", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(small.Rows) != 4 || small.Totals.Chat.Rows != 3 || small.Totals.Chat != (AIUsageTotals{Groups: 501, Rows: 3, Requests: 502, Failures: 1,
		PromptTokens: chat.PromptTokens, CompletionTokens: chat.CompletionTokens, TotalTokens: chatTokens, TokenRequests: 501, ToolCalls: 501, Truncated: true}) {
		t.Fatalf("limit 3: rows %d, chat totals %+v", len(small.Rows), small.Totals.Chat)
	}

	// same model on both sources: two rows; an investigation's cluster comes from the column
	byModel, err := repo.AIUsage(ctx, since, until, "model", 500)
	if err != nil {
		t.Fatal(err)
	}
	var models []string
	for _, r := range byModel.Rows {
		models = append(models, fmt.Sprintf("%s/%s/%d", r.Source, r.Key, r.TotalTokens))
	}
	if want := []string{fmt.Sprintf("chat/m1/%d", chatTokens), "investigation/m1/350", "investigation//0"}; fmt.Sprint(models) != fmt.Sprint(want) {
		t.Fatalf("model rows %v, want %v", models, want)
	}
	byCluster, err := repo.AIUsage(ctx, since, until, "cluster", 500)
	if err != nil {
		t.Fatal(err)
	}
	var clusters []string
	for _, r := range byCluster.Rows {
		clusters = append(clusters, r.Source+"/"+r.Key)
	}
	if want := []string{"chat/self", "investigation/default"}; fmt.Sprint(clusters) != fmt.Sprint(want) {
		t.Fatalf("cluster rows %v, want %v", clusters, want)
	}
}
