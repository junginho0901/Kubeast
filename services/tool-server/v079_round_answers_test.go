package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
)

// The v0.7.9 switches tool-server reads or passes on, each unset: what the chart renders by default.
var v079ToolServerSwitches = []string{
	"AI_TIMELINE_CHANGES", "ALERT_INVESTIGATION_ENABLED", "ALERT_INVESTIGATION_CHANGES_FIRST", "CALL_GRAPH_ENABLED",
	"ANOMALY_RANK_ENABLED", "AI_TOOL_RESULT_DETAILS", "AI_TOOL_RESULTS_JSON", "LOG_SEARCH_QUERY_MAX_BYTES", "REDACTION_NUMBERED",
}

// What k8s-service and kubectl answer the round, fixed.
const (
	roundTimelineAnswer = `{"namespace":"shop","window":{"since":"2026-11-15T00:00:00Z","until":"2026-11-15T04:00:00Z"},` +
		`"summary":{"events_total":2,"rollouts_total":1},"events_shown":1,"events_matching":2,"events_note":"newest 1 of 2",` +
		`"events":[{"type":"Warning","reason":"BackOff","object":"Pod/web-1","message":"Back-off restarting failed container app",` +
		`"first_timestamp":"2026-11-15T03:50:00Z","last_timestamp":"2026-11-15T03:58:00Z","count":7}],` +
		`"rollouts":[{"kind":"Deployment","name":"web","revision":4,"created":"2026-11-15T03:40:00Z"}]}`
	roundGraphAnswer = `{"summary":{"nodes":2,"edges":1,"by_kind":{"Deployment":1,"Service":1}},` +
		`"nodes":[{"id":"Deployment/shop/web","kind":"Deployment","name":"web","namespace":"shop","health":"warn"},` +
		`{"id":"Service/shop/web","kind":"Service","name":"web","namespace":"shop","health":"ok"}],` +
		`"edges":[{"source":"Service/shop/web","target":"Deployment/shop/web","type":"selector"}]}`
	roundLogQLAnswer = `{"resultType":"matrix","series":[{"metric":{"pod":"web-1"},"values":[[1763178000,"12"],[1763178300,"30"]]}],` +
		`"seriesTotal":1,"truncated":false,"effectiveQuery":"sum by (pod) (count_over_time({namespace=\"shop\"} |= \"error\" [5m]))"}`
)

// sha256 of each answer and of what tool-server asked k8s-service, as main d58cf599 gives them.
var v078RoundAnswers = map[string]string{
	"timeline":         "f926c99f44753357f21d03080289e1a471565aa3cb37f2dbe6de675af3a317ab",
	"resource_graph":   "23a16d58c646f67889f593db831813209aee99430c63c89ade55773039174e2a",
	"loki_query":       "f59c529b2736aa733f8c046e4890af061378c99d8387d557b8f51cb9cf2f86c2",
	"k8s_get_pod_logs": "3d6c255b40904e4bd26dea914659c78eee5bf83dc12d0639faad9eee604a3da3",
	"asked":            "cb413b9c281639f171144101833b0a6d4f230585a506af4ed59dfffa38df4d9e",
}

// With every v0.7.9 switch off, what tool-server answers the four tools of test_v079_switches_off.py's round (with
// windows no clock moves), over a fixed k8s-service and kubectl, and what it asks k8s-service for them,
// are main's (0.7.8's), held as sha256: a switch's change to a handler that reaches the model with the switch off shows here.
func TestWithEveryV079SwitchOffTheRoundsAnswersAreV078s(t *testing.T) {
	for _, name := range v079ToolServerSwitches {
		t.Setenv(name, "")
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		switch {
		case strings.Contains(r.URL.Path, "/timeline"):
			return 200, roundTimelineAnswer
		case strings.Contains(r.URL.Path, "/resource-graph"):
			return 200, roundGraphAnswer
		case strings.Contains(r.URL.Path, "/logsearch/logql"):
			return 200, roundLogQLAnswer
		}
		return 404, `{"detail":"not served by the stand-in"}`
	})
	kubeletLogs(t, []string{"2026-11-15T03:58:01Z ERROR java.lang.OutOfMemoryError: Java heap space", "2026-11-15T03:58:02Z INFO shutting down"})
	for _, c := range []struct {
		tool    string
		handler func(context.Context, map[string]interface{}, http.Header) (string, error)
		args    args
	}{
		// windows a clock does not move: a relative start for timeline, a fixed one for LogQL
		{"timeline", handleTimeline, args{"namespace": "shop", "since_time": "6h"}},
		{"resource_graph", handleResourceGraph, args{"namespace": "shop"}},
		{"loki_query", handleLokiQuery, args{"logql": `sum by (pod) (count_over_time({namespace="shop"} |= "error" [5m]))`, "namespace": "shop",
			"since_time": "2026-11-15T03:00:00Z", "until_time": "2026-11-15T04:00:00Z", "step": 300}},
		{"k8s_get_pod_logs", handleGetPodLogs, args{"namespace": "shop", "pod_name": "web-1", "tail_lines": 20, "container": "app"}},
	} {
		out, err := c.handler(ctxFor("c1"), c.args, bearer())
		if err != nil {
			out = "error: " + err.Error()
		}
		if got := roundSHA(out); got != v078RoundAnswers[c.tool] {
			t.Errorf("%s answers %s, 0.7.8 %s:\n%s", c.tool, got, v078RoundAnswers[c.tool], out)
		}
	}
	var asked []string
	for _, r := range *seen {
		q := r.URL.Query()
		keys := make([]string, 0, len(q))
		for k := range q {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s=%s", k, strings.Join(q[k], ",")))
		}
		asked = append(asked, r.Method+" "+r.URL.Path+"?"+strings.Join(parts, "&"))
	}
	if got := roundSHA(strings.Join(asked, "\n")); got != v078RoundAnswers["asked"] {
		t.Errorf("asked k8s-service %s, 0.7.8 %s:\n%s", got, v078RoundAnswers["asked"], strings.Join(asked, "\n"))
	}
}

func roundSHA(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
