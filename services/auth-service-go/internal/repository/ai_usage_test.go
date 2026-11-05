package repository

import (
	"fmt"
	"strings"
	"testing"
)

func TestAIUsageKeyExpr(t *testing.T) {
	for _, g := range []string{"user", "model", "cluster"} {
		if chat, inv, ok := aiUsageKeyExpr(g); !ok || chat == "" || inv == "" {
			t.Fatalf("group %q must map to a SQL expression for both sources", g)
		}
	}
	for _, g := range []string{"", "actor_email; DROP TABLE x", "namespace"} {
		if _, _, ok := aiUsageKeyExpr(g); ok {
			t.Fatalf("group %q must be rejected", g)
		}
	}
	// ai-service writes an investigation's cluster in the column only (after has no cluster).
	if _, inv, _ := aiUsageKeyExpr("cluster"); inv != "COALESCE(cluster, '')" {
		t.Fatalf("investigation cluster key = %q", inv)
	}
}

func TestAIUsageQuery_TotalsBeforeTheLimit(t *testing.T) {
	chat, inv, _ := aiUsageKeyExpr("model")
	q := strings.Join(strings.Fields(aiUsageQuery(chat, inv)), " ")
	for _, want := range []string{
		"WHERE action IN ('ai.chat.complete', 'ai.investigation.run')",
		"CASE action WHEN 'ai.investigation.run' THEN 'investigation' ELSE 'chat' END AS source",
		"GROUP BY source, key",
		"ROW_NUMBER() OVER (PARTITION BY source ORDER BY total_tokens DESC, requests DESC, key) AS pos",
		"COUNT(*) OVER src AS src_groups",
		"SUM(total_tokens) OVER src AS src_total_tokens",
		"WINDOW src AS (PARTITION BY source)",
		"WHERE pos <= $3",
		"ORDER BY total_tokens DESC, requests DESC, source, key",
	} {
		if !strings.Contains(q, want) {
			t.Errorf("query lacks %q", want)
		}
	}
	if strings.Contains(q, "LIMIT") {
		t.Errorf("a LIMIT would cut before the window sums: %s", q)
	}
}

// scansFor stands in for what the query returns: the first limit groups of a
// source, each carrying the window sums over every group of that source.
func scansFor(source string, groups, limit int, tokens func(i int) int64) []aiUsageScan {
	var all AIUsageTotals
	for i := 0; i < groups; i++ {
		all.Groups++
		all.Requests += 2
		all.Failures++
		all.PromptTokens += tokens(i) - 10
		all.CompletionTokens += 10
		all.TotalTokens += tokens(i)
		all.TokenRequests += 2
		all.ToolCalls += 3
	}
	var out []aiUsageScan
	for i := 0; i < groups && i < limit; i++ {
		out = append(out, aiUsageScan{
			row: AIUsageRow{Source: source, Key: fmt.Sprintf("%s-%03d", source, i), Requests: 2, Failures: 1,
				PromptTokens: tokens(i) - 10, CompletionTokens: 10, TotalTokens: tokens(i), TokenRequests: 2, ToolCalls: 3},
			cached: 7, promptChars: 900, source: all,
		})
	}
	return out
}

func TestBuildAIUsageReport_501Groups(t *testing.T) {
	tokens := func(i int) int64 { return int64(10_000 - i) }
	report := buildAIUsageReport(scansFor(AIUsageChat, 501, 500, tokens), 500)

	var sum501 int64
	for i := 0; i < 501; i++ {
		sum501 += tokens(i)
	}
	if len(report.Rows) != 500 || report.Limit != 500 {
		t.Fatalf("rows %d limit %d, want 500 500", len(report.Rows), report.Limit)
	}
	chat := report.Totals.Chat
	if chat.Groups != 501 || chat.Rows != 500 || !chat.Truncated || !report.Truncated {
		t.Fatalf("chat groups %d rows %d truncated %v/%v, want 501 500 true", chat.Groups, chat.Rows, chat.Truncated, report.Truncated)
	}
	if chat.TotalTokens != sum501 || chat.Requests != 1002 || chat.Failures != 501 || chat.ToolCalls != 1503 {
		t.Fatalf("chat totals tokens %d requests %d failures %d tools %d, want %d 1002 501 1503",
			chat.TotalTokens, chat.Requests, chat.Failures, chat.ToolCalls, sum501)
	}
	if all := report.Totals.All; all.TotalTokens != sum501 || all.Groups != 501 || all.Rows != 500 || !all.Truncated {
		t.Fatalf("all totals %+v", all)
	}

	// exactly the limit is not cut
	report = buildAIUsageReport(scansFor(AIUsageChat, 500, 500, tokens), 500)
	if report.Truncated || report.Totals.Chat.Truncated || report.Totals.Chat.Groups != 500 {
		t.Fatalf("500 groups of 500: truncated %v, groups %d", report.Truncated, report.Totals.Chat.Groups)
	}
}

func TestBuildAIUsageReport_InvestigationsApart(t *testing.T) {
	chat := scansFor(AIUsageChat, 2, 500, func(i int) int64 { return 1_000 })
	inv := scansFor(AIUsageInvestigation, 1, 500, func(i int) int64 { return 400 })
	inv[0].row.Key = chat[0].row.Key // same key: still a row of its own
	report := buildAIUsageReport(append(chat, inv...), 500)

	if len(report.Rows) != 3 {
		t.Fatalf("rows %d, want 3 (two chat, one investigation)", len(report.Rows))
	}
	var got []string
	for _, r := range report.Rows {
		got = append(got, r.Source+"/"+r.Key)
	}
	if strings.Join(got, ",") != "chat/chat-000,chat/chat-001,investigation/chat-000" {
		t.Fatalf("rows %v", got)
	}
	invRow := report.Rows[2]
	if invRow.CachedTokens != nil || invRow.PromptChars != nil {
		t.Fatalf("an investigation records no cache or prompt size: cached %v chars %v", invRow.CachedTokens, invRow.PromptChars)
	}
	if c := report.Rows[0].CachedTokens; c == nil || *c != 7 {
		t.Fatalf("chat cached tokens %v, want 7", c)
	}
	if invRow.ToolCalls != 3 || invRow.Failures != 1 {
		t.Fatalf("investigation tool calls %d failures %d, want 3 1", invRow.ToolCalls, invRow.Failures)
	}
	tot := report.Totals
	if tot.Chat.TotalTokens != 2_000 || tot.Investigation.TotalTokens != 400 || tot.All.TotalTokens != 2_400 {
		t.Fatalf("totals chat %d investigation %d all %d, want 2000 400 2400", tot.Chat.TotalTokens, tot.Investigation.TotalTokens, tot.All.TotalTokens)
	}
	if tot.Chat.Groups != 2 || tot.Investigation.Groups != 1 || tot.All.Groups != 3 || tot.All.Requests != 6 || report.Truncated {
		t.Fatalf("groups %d %d %d requests %d truncated %v", tot.Chat.Groups, tot.Investigation.Groups, tot.All.Groups, tot.All.Requests, report.Truncated)
	}

	// no investigation in the period: its totals are zero, not missing
	report = buildAIUsageReport(chat, 500)
	if report.Totals.Investigation != (AIUsageTotals{}) || report.Totals.All.TotalTokens != 2_000 {
		t.Fatalf("totals %+v", report.Totals)
	}
}
