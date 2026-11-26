package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func anomalyFinding(i int, examples bool) string {
	ex := ""
	if examples {
		ex = fmt.Sprintf(`,"examples":["web-%d-a/app exit 137 at 2026-11-15T01:2%d:00Z","web-%d-b/app exit 137 at 2026-11-15T01:1%d:00Z","web-%d-c/app exit 137 at 2026-11-15T01:0%d:00Z"]`, i, i%10, i, i%10, i, i%10)
	}
	return fmt.Sprintf(`{"check":"restarts","target":"Pod/web-%d-a-with-a-rather-long-generated-name","verdict":"anomalous","summary":"%d restarts in the window, 1 in the window before and some more words to fill the line","before":1,"now":%d,"ratio":%d%s}`, i, i+2, i+2, i+2, ex)
}

func anomalyReply(findings []string) string {
	return `{"namespace":"shop","window":{"start":"2026-11-15T00:30:00Z","end":"2026-11-15T01:30:00Z"},"compared_with":{"start":"2026-11-14T23:30:00Z","end":"2026-11-15T00:30:00Z"},` +
		`"findings":[` + strings.Join(findings, ",") + `],"findings_total":` + fmt.Sprint(len(findings)) + `,"normal":["memory_near_limit"],` +
		`"not_run":[{"check":"node_conditions_not_cpu","reason":"the nodes could not be listed: forbidden"}],"store_queries":6}`
}

func TestAnomalyRank_AsksTheNamespacesWindowAndWorkload(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, anomalyReply([]string{anomalyFinding(1, true)}) })
	args := map[string]interface{}{"namespace": "shop", "since_time": "2026-11-15T00:30:00Z", "until_time": "2026-11-15T01:30:00Z", "workload_kind": "Deployment", "workload_name": "web"}
	if err := validateToolArgs(args); err != nil {
		t.Fatal(err)
	}
	out, err := handleAnomalyRank(ctxFor("c1"), args, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/namespaces/shop/anomalies" || q.Get("start") != "2026-11-15T00:30:00Z" || q.Get("end") != "2026-11-15T01:30:00Z" ||
		q.Get("workload_kind") != "Deployment" || q.Get("workload_name") != "web" || q.Get("cluster") != "c1" {
		t.Fatalf("request %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	// what the model needs first comes first, the findings last
	if !strings.HasPrefix(out, `{"namespace":"shop","window":`) || strings.Index(out, `"not_run"`) > strings.Index(out, `"findings":[`) {
		t.Fatalf("order: %s", out)
	}
	m := decode(t, out)
	if len(m["findings"].([]interface{})) != 1 || m["examples_note"] != nil || m["findings_note"] != nil {
		t.Fatalf("a short answer was cut: %s", out)
	}
}

// since_time 2h counts back from the minute k8s-service ends a window it is not given.
func TestAnomalyRank_ARelativeStartCountsBackFromTheMinute(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, anomalyReply(nil) })
	if _, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "since_time": "2h"}, bearer()); err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	start, err := time.Parse(time.RFC3339, q.Get("start"))
	if err != nil || start.Second() != 0 || q.Get("end") != "" {
		t.Fatalf("start %q end %q", q.Get("start"), q.Get("end"))
	}
	if d := time.Now().Truncate(time.Minute).Sub(start); d < 2*time.Hour-time.Minute || d > 2*time.Hour+time.Minute {
		t.Fatalf("start %s is %s back", start, d)
	}
	if _, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer()); err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[1].URL.Query(); q.Get("start") != "" || q.Get("end") != "" {
		t.Fatalf("no window asked, one sent: %s", (*seen)[1].URL.RawQuery)
	}
}

func TestAnomalyRank_RefusesWhatItCannotAsk(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, anomalyReply(nil) })
	for _, args := range []map[string]interface{}{
		{},
		{"namespace": "shop", "workload_kind": "Deployment"},
		{"namespace": "shop", "workload_name": "web"},
		{"namespace": "shop", "until_time": "now"},
		{"namespace": "shop", "since_time": "yesterday"},
	} {
		if _, err := handleAnomalyRank(ctxFor("c1"), args, bearer()); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v, want a bad request", args, err)
		}
	}
}

// The answer stays within anomalyRankChars: examples go first, then the last findings, and the answer says so.
func TestAnomalyRank_KeepsTheAnswerShortAndSaysWhatWasCut(t *testing.T) {
	findings := make([]string, 10)
	for i := range findings {
		findings[i] = anomalyFinding(i, true)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, anomalyReply(findings) })
	out, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > anomalyRankChars {
		t.Fatalf("%d characters", len(out))
	}
	m := decode(t, out)
	listed := m["findings"].([]interface{})
	if m["examples_note"] == nil || m["findings_total"] != float64(10) || len(listed) == 0 {
		t.Fatalf("%s", out)
	}
	if first := listed[0].(map[string]interface{}); first["target"] != "Pod/web-0-a-with-a-rather-long-generated-name" {
		t.Fatalf("the first finding is not the first one ranked: %v", first)
	}
	if len(listed) < 10 && !strings.Contains(fmt.Sprint(m["findings_note"]), fmt.Sprintf("first %d of the 10", len(listed))) {
		t.Fatalf("cut without saying so: %v", m["findings_note"])
	}
}

// Every check that could not run, or ran on part of what it reads, keeps its name and reason however long the answer is:
// only examples and the last findings are cut.
func TestAnomalyRank_KeepsEveryReasonACheckDidNotRun(t *testing.T) {
	findings := make([]string, 10)
	for i := range findings {
		findings[i] = anomalyFinding(i, true)
	}
	reply := strings.Replace(anomalyReply(findings), `"not_run":[`,
		`"partial":[{"check":"trace_latency","reason":"not compared, no server spans in the window before: service pay"}],`+
			`"not_run":[{"check":"error_log_patterns","reason":"`+strings.Repeat("the log store does not serve log shapes ", 8)+`"},`, 1)
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, reply })
	out, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil || len(out) > anomalyRankChars {
		t.Fatalf("%d characters, %v", len(out), err)
	}
	m := decode(t, out)
	for _, want := range []string{"node_conditions_not_cpu", "the nodes could not be listed: forbidden", "error_log_patterns", strings.Repeat("the log store does not serve log shapes ", 8),
		"not compared, no server spans in the window before: service pay", "memory_near_limit"} {
		if !strings.Contains(out, want) {
			t.Errorf("%q was cut: %s", want, out)
		}
	}
	if m["findings_note"] == nil {
		t.Fatalf("not cut: %s", out)
	}
}

// no_baseline comes right after the windows, before the counts and the findings the model reads after it, and stays when
// the answer is cut; an answer without it is written as the key list before it wrote it.
func TestAnomalyRank_NoBaselineComesFirstAndStays(t *testing.T) {
	findings := make([]string, 10)
	for i := range findings {
		findings[i] = anomalyFinding(i, true)
	}
	noBaseline := `"no_baseline":{"compared":30,"no_earlier_data":30,"note":"Most values compared have no data in the window before, so the findings show what is there now, not what changed. ` +
		`Read the namespace's events, recent changes and logs before following the first finding."}`
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, strings.Replace(anomalyReply(findings), `"findings":[`, noBaseline+`,"findings":[`, 1)
	})
	out, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil || len(out) > anomalyRankChars {
		t.Fatalf("%d characters, %v", len(out), err)
	}
	if !strings.Contains(out, `"compared_with":{"end":"2026-11-15T00:30:00Z","start":"2026-11-14T23:30:00Z"},`+noBaseline+`,"findings_total":10,`) {
		t.Fatalf("no_baseline is not right after the windows: %s", out)
	}
	if m := decode(t, out); m["findings_note"] == nil {
		t.Fatalf("not cut: %s", out)
	}

	before := []string{"namespace", "workload", "window", "compared_with", "findings_total", "findings_note", "examples_note", "call_order", "not_run", "normal", "store_queries"}
	reply := anomalyReply([]string{anomalyFinding(1, true)})
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, reply })
	out, err = handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	want, err := marshalOrdered(decode(t, reply), before, anomalyLastKeys)
	if err != nil || out != want || strings.Contains(out, "no_baseline") {
		t.Fatalf("without no_baseline\n%s\nwant\n%s", out, want)
	}
}

func TestAnomalyRank_OffIsUnavailableWithTheIssueCheckInstead(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"anomaly ranking is off (features.anomalyRank.enabled)"}`
	})
	out, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || m["alternative"] != "issues" {
		t.Fatalf("off: %s %v", out, err)
	}
}

// What leaves for the model goes through the masking: a password in a message does not stay, the rest does.
func TestAnomalyRank_TheMaskingTakesAPasswordInASummary(t *testing.T) {
	finding := `{"check":"issues","target":"Pod/web-1-a","verdict":"anomalous","summary":"critical: CrashLoopBackOff dial postgres://app:fake-db-password@db.shop:5432 refused","new":true}`
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, anomalyReply([]string{finding}) })
	out, err := handleAnomalyRank(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	masked, _ := redactToolOutput(out)
	if strings.Contains(masked, "fake-db-password") || !strings.Contains(masked, "CrashLoopBackOff") || !strings.Contains(masked, "Pod/web-1-a") {
		t.Fatalf("masked: %s", masked)
	}
}
