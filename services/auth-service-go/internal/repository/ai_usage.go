package repository

import (
	"context"
	"fmt"
	"time"
)

// The audit actions the admin AI-usage view adds up, one source each. Rows of
// different sources are never merged, also when their key is the same.
const (
	AIUsageChat          = "chat"          // ai.chat.complete: chat turns and Optimization explanations
	AIUsageInvestigation = "investigation" // ai.investigation.run: alert investigations
)

// AIUsageLimit is how many groups of each source one answer lists.
const AIUsageLimit = 500

// AIUsageRow is one aggregated line of the admin AI-usage view: the records of
// one source in a period grouped by user, model or cluster.
type AIUsageRow struct {
	Source           string  `json:"source"`
	Key              string  `json:"key"`
	Requests         int64   `json:"requests"`
	Failures         int64   `json:"failures"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	CachedTokens     *int64  `json:"cached_tokens"`  // prompt tokens the provider served from its cache; null when the source does not record it
	PromptChars      *int64  `json:"prompt_chars"`   // what ai-service sent, counted by itself; null when the source does not record it
	TokenRequests    int64   `json:"token_requests"` // requests whose record has a token count
	ToolCalls        int64   `json:"tool_calls"`
	AvgDurationMs    float64 `json:"avg_duration_ms"`
	LastAt           string  `json:"last_at"`
}

// AIUsageTotals adds up every group of a source in the period, also the ones
// past the limit; Rows is how many of them the answer lists.
type AIUsageTotals struct {
	Groups           int64 `json:"groups"`
	Rows             int64 `json:"rows"`
	Requests         int64 `json:"requests"`
	Failures         int64 `json:"failures"`
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
	TokenRequests    int64 `json:"token_requests"`
	ToolCalls        int64 `json:"tool_calls"`
	Truncated        bool  `json:"truncated"`
}

func (t AIUsageTotals) plus(o AIUsageTotals) AIUsageTotals {
	return AIUsageTotals{
		Groups:           t.Groups + o.Groups,
		Rows:             t.Rows + o.Rows,
		Requests:         t.Requests + o.Requests,
		Failures:         t.Failures + o.Failures,
		PromptTokens:     t.PromptTokens + o.PromptTokens,
		CompletionTokens: t.CompletionTokens + o.CompletionTokens,
		TotalTokens:      t.TotalTokens + o.TotalTokens,
		TokenRequests:    t.TokenRequests + o.TokenRequests,
		ToolCalls:        t.ToolCalls + o.ToolCalls,
		Truncated:        t.Truncated || o.Truncated,
	}
}

type AIUsageTotalsBySource struct {
	Chat          AIUsageTotals `json:"chat"`
	Investigation AIUsageTotals `json:"investigation"`
	All           AIUsageTotals `json:"all"`
}

// AIUsageReport is one answer: the listed rows of both sources, most tokens
// first, and the totals over every group.
type AIUsageReport struct {
	Rows      []AIUsageRow
	Limit     int
	Truncated bool
	Totals    AIUsageTotalsBySource
}

// aiUsageKeyExpr maps the group parameter to the SQL expression each source's
// rows are grouped by. An investigation run is written by the investigator
// (actor kubeast:investigator) and keeps its cluster in the cluster column
// only. Unknown groups are rejected by the caller.
func aiUsageKeyExpr(group string) (chat, investigation string, ok bool) {
	switch group {
	case "user":
		return "COALESCE(actor_email, actor_user_id, '')", "COALESCE(actor_email, actor_user_id, '')", true
	case "model":
		return "COALESCE(after->>'model', '')", "COALESCE(after->>'model', '')", true
	case "cluster":
		return "COALESCE(after->>'cluster', '')", "COALESCE(cluster, '')", true
	}
	return "", "", false
}

// aiUsageQuery groups both sources in one statement: the window sums over each
// source's groups are taken before ROW_NUMBER keeps its first $3, so totals
// and group counts include the groups past the limit.
func aiUsageQuery(chatKey, invKey string) string {
	return fmt.Sprintf(`
        WITH picked AS (
            SELECT CASE action WHEN 'ai.investigation.run' THEN 'investigation' ELSE 'chat' END AS source,
                   CASE action WHEN 'ai.investigation.run' THEN %s ELSE %s END AS key,
                   result, after, created_at
              FROM auth_audit_logs
             WHERE action IN ('ai.chat.complete', 'ai.investigation.run')
               AND created_at >= $1 AND created_at < $2
        ), grouped AS (
            SELECT source, key,
                   COUNT(*) AS requests,
                   COUNT(*) FILTER (WHERE result = 'failure') AS failures,
                   COALESCE(SUM((after->>'prompt_tokens')::bigint), 0) AS prompt_tokens,
                   COALESCE(SUM((after->>'completion_tokens')::bigint), 0) AS completion_tokens,
                   COALESCE(SUM((after->>'total_tokens')::bigint), 0) AS total_tokens,
                   COALESCE(SUM((after->>'cached_tokens')::bigint), 0) AS cached_tokens,
                   COALESCE(SUM((after->>'prompt_chars')::bigint), 0) AS prompt_chars,
                   COUNT(after->>'total_tokens') AS token_requests,
                   COALESCE(SUM((after->>'tool_calls')::bigint), 0) AS tool_calls,
                   COALESCE(AVG((after->>'duration_ms')::numeric), 0) AS avg_duration_ms,
                   MAX(created_at) AS last_at
              FROM picked
             GROUP BY source, key
        ), ranked AS (
            SELECT grouped.*,
                   ROW_NUMBER() OVER (PARTITION BY source ORDER BY total_tokens DESC, requests DESC, key) AS pos,
                   COUNT(*) OVER src AS src_groups,
                   SUM(requests) OVER src AS src_requests,
                   SUM(failures) OVER src AS src_failures,
                   SUM(prompt_tokens) OVER src AS src_prompt_tokens,
                   SUM(completion_tokens) OVER src AS src_completion_tokens,
                   SUM(total_tokens) OVER src AS src_total_tokens,
                   SUM(token_requests) OVER src AS src_token_requests,
                   SUM(tool_calls) OVER src AS src_tool_calls
              FROM grouped
            WINDOW src AS (PARTITION BY source)
        )
        SELECT source, key, requests, failures, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
               prompt_chars, token_requests, tool_calls, avg_duration_ms, last_at,
               src_groups, src_requests, src_failures, src_prompt_tokens, src_completion_tokens, src_total_tokens,
               src_token_requests, src_tool_calls
          FROM ranked
         WHERE pos <= $3
         ORDER BY total_tokens DESC, requests DESC, source, key`, invKey, chatKey)
}

// aiUsageScan is one result row: a listed group and its source's window sums.
type aiUsageScan struct {
	row         AIUsageRow
	cached      int64
	promptChars int64
	source      AIUsageTotals
}

// buildAIUsageReport turns the result rows into the answer. An investigation
// record has no cache or prompt-size fields, so those stay null rather than 0.
func buildAIUsageReport(scans []aiUsageScan, limit int) AIUsageReport {
	report := AIUsageReport{Rows: make([]AIUsageRow, 0, len(scans)), Limit: limit}
	totals := map[string]*AIUsageTotals{AIUsageChat: &report.Totals.Chat, AIUsageInvestigation: &report.Totals.Investigation}
	for _, s := range scans {
		row := s.row
		if row.Source != AIUsageInvestigation {
			cached, chars := s.cached, s.promptChars
			row.CachedTokens, row.PromptChars = &cached, &chars
		}
		report.Rows = append(report.Rows, row)
		t, ok := totals[row.Source]
		if !ok {
			continue
		}
		rows := t.Rows
		*t = s.source
		t.Rows = rows + 1
	}
	for _, t := range totals {
		t.Truncated = t.Groups > t.Rows
	}
	report.Totals.All = report.Totals.Chat.plus(report.Totals.Investigation)
	report.Truncated = report.Totals.All.Truncated
	return report
}

// AIUsage aggregates the ai.chat.complete and ai.investigation.run records
// between since (inclusive) and until (exclusive), each source apart, listing
// at most limit groups of each. Token sums skip records with no token count
// (JSON null), so TokenRequests tells how many requests the sums cover.
func (r *Repository) AIUsage(ctx context.Context, since, until time.Time, group string, limit int) (AIUsageReport, error) {
	chatKey, invKey, ok := aiUsageKeyExpr(group)
	if !ok {
		return AIUsageReport{}, fmt.Errorf("unknown group %q", group)
	}
	rows, err := r.pool.Query(ctx, aiUsageQuery(chatKey, invKey), since, until, limit)
	if err != nil {
		return AIUsageReport{}, fmt.Errorf("ai usage: %w", err)
	}
	defer rows.Close()

	scans := []aiUsageScan{}
	for rows.Next() {
		var s aiUsageScan
		var last time.Time
		if err := rows.Scan(&s.row.Source, &s.row.Key, &s.row.Requests, &s.row.Failures, &s.row.PromptTokens, &s.row.CompletionTokens,
			&s.row.TotalTokens, &s.cached, &s.promptChars, &s.row.TokenRequests, &s.row.ToolCalls, &s.row.AvgDurationMs, &last,
			&s.source.Groups, &s.source.Requests, &s.source.Failures, &s.source.PromptTokens, &s.source.CompletionTokens,
			&s.source.TotalTokens, &s.source.TokenRequests, &s.source.ToolCalls); err != nil {
			return AIUsageReport{}, fmt.Errorf("ai usage scan: %w", err)
		}
		s.row.LastAt = last.UTC().Format(time.RFC3339)
		scans = append(scans, s)
	}
	if err := rows.Err(); err != nil {
		return AIUsageReport{}, fmt.Errorf("ai usage: %w", err)
	}
	return buildAIUsageReport(scans, limit), nil
}
