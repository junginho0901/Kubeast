package repository

import (
	"context"
	"fmt"
	"time"
)

// AIUsageRow is one aggregated line of the admin AI-usage view: the
// ai.chat.complete audit records of a period grouped by user or model.
type AIUsageRow struct {
	Key              string  `json:"key"`
	Requests         int64   `json:"requests"`
	Failures         int64   `json:"failures"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	TokenRequests    int64   `json:"token_requests"` // requests whose provider reported usage
	ToolCalls        int64   `json:"tool_calls"`
	AvgDurationMs    float64 `json:"avg_duration_ms"`
	LastAt           string  `json:"last_at"`
}

// aiUsageKeyExpr maps the group parameter to the SQL expression the rows are
// grouped by. Unknown groups are rejected by the caller.
func aiUsageKeyExpr(group string) (string, bool) {
	switch group {
	case "user":
		return "COALESCE(actor_email, actor_user_id, '')", true
	case "model":
		return "COALESCE(after->>'model', '')", true
	case "cluster":
		return "COALESCE(after->>'cluster', '')", true
	}
	return "", false
}

// AIUsage aggregates ai.chat.complete records between since (inclusive) and
// until (exclusive). Token sums skip records whose provider sent no usage
// (JSON null), so TokenRequests tells how many requests the sums cover.
func (r *Repository) AIUsage(ctx context.Context, since, until time.Time, group string) ([]AIUsageRow, error) {
	keyExpr, ok := aiUsageKeyExpr(group)
	if !ok {
		return nil, fmt.Errorf("unknown group %q", group)
	}
	q := fmt.Sprintf(`
        SELECT %s AS key,
               COUNT(*) AS requests,
               COUNT(*) FILTER (WHERE result = 'failure') AS failures,
               COALESCE(SUM((after->>'prompt_tokens')::bigint), 0),
               COALESCE(SUM((after->>'completion_tokens')::bigint), 0),
               COALESCE(SUM((after->>'total_tokens')::bigint), 0),
               COUNT(after->>'total_tokens') AS token_requests,
               COALESCE(SUM((after->>'tool_calls')::bigint), 0),
               COALESCE(AVG((after->>'duration_ms')::numeric), 0),
               MAX(created_at)
          FROM auth_audit_logs
         WHERE action = 'ai.chat.complete'
           AND created_at >= $1 AND created_at < $2
         GROUP BY 1
         ORDER BY 6 DESC, 2 DESC
         LIMIT 500`, keyExpr)

	rows, err := r.pool.Query(ctx, q, since, until)
	if err != nil {
		return nil, fmt.Errorf("ai usage: %w", err)
	}
	defer rows.Close()

	out := []AIUsageRow{}
	for rows.Next() {
		var row AIUsageRow
		var last time.Time
		if err := rows.Scan(&row.Key, &row.Requests, &row.Failures, &row.PromptTokens, &row.CompletionTokens,
			&row.TotalTokens, &row.TokenRequests, &row.ToolCalls, &row.AvgDurationMs, &last); err != nil {
			return nil, fmt.Errorf("ai usage scan: %w", err)
		}
		row.LastAt = last.UTC().Format(time.RFC3339)
		out = append(out, row)
	}
	return out, rows.Err()
}
