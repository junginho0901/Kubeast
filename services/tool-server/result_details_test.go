package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// The keys AI_TOOL_RESULT_DETAILS adds, and the ones that move with the clock between two calls.
var detailKeys = []string{"cut", "default_window", "empty_reason"}

func withDetails(t *testing.T, on bool) {
	t.Helper()
	if on {
		t.Setenv("AI_TOOL_RESULT_DETAILS", "true")
	} else {
		t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	}
}

func seriesJSON(n, points int) string {
	pts := make([]string, points)
	for i := range pts {
		pts[i] = fmt.Sprintf(`{"t":%d,"v":"1"}`, 1700000000+15*i)
	}
	rows := make([]string, n)
	for i := range rows {
		rows[i] = fmt.Sprintf(`{"metric":{"pod":"p%d"},"points":[%s]}`, i, strings.Join(pts, ","))
	}
	return "[" + strings.Join(rows, ",") + "]"
}

func linesJSON(n int) string {
	rows := make([]string, n)
	for i := range rows {
		rows[i] = fmt.Sprintf(`{"timestamp":"2026-11-15T00:00:%02dZ","line":"error %d"}`, i, i)
	}
	return "[" + strings.Join(rows, ",") + "]"
}

type detailCase struct {
	name    string
	handler func(context.Context, map[string]interface{}, http.Header) (string, error)
	args    map[string]interface{}
	reply   string
	want    map[string]string // key → text it holds; "" = the key is absent
	ordered bool              // the answer is marshalOrdered: compared by value, not by bytes
}

func detailCases(t *testing.T) []detailCase {
	spans := make([]string, 120)
	for i := range spans {
		spans[i] = fmt.Sprintf(`{"spanId":"%016x","name":"op"}`, i)
	}
	rules := make([]string, 120)
	for i := range rules {
		rules[i] = fmt.Sprintf(`{"name":"r%d","state":"inactive"}`, i)
	}
	none := map[string]string{"cut": "", "default_window": "", "empty_reason": ""}
	return []detailCase{
		{name: "prometheus range cut, default window", handler: handlePrometheusQuery, args: args{"promql": "up", "range": true},
			reply: `{"available":true,"results":` + seriesJSON(150, 130) + `}`,
			want:  map[string]string{"cut": "100 of 150 series; points thinned to 120 per series, of up to 130", "default_window": "the last 1h was read", "empty_reason": ""}},
		{name: "prometheus range with since", handler: handlePrometheusQuery, args: args{"promql": "up", "since": "6h", "range": true},
			reply: `{"available":true,"results":` + seriesJSON(2, 10) + `}`, want: none},
		{name: "prometheus range with a since that is not a duration", handler: handlePrometheusQuery, args: args{"promql": "up", "since": "1d", "range": true},
			reply: `{"available":true,"results":[]}`, want: map[string]string{"default_window": "since is not a duration", "empty_reason": ""}},
		{name: "prometheus instant, empty", handler: handlePrometheusQuery, args: args{"promql": "up"},
			reply: `{"available":true,"results":[]}`, want: map[string]string{"empty_reason": "lookback, 5 minutes", "default_window": "", "cut": ""}},
		{name: "prometheus labels cut, k8s-service's default window", handler: handlePrometheusLabels, args: args{"label": "namespace"},
			reply: `{"available":true,"values":["a","b"],"truncated":true,"since":"1h0m0s"}`,
			want:  map[string]string{"cut": "2 values shown; the total is not known", "default_window": "seen in the last 1h were read"}},
		{name: "prometheus labels with since", handler: handlePrometheusLabels, args: args{"since": "6h"},
			reply: `{"available":true,"names":["job"],"since":"6h0m0s"}`, want: none},
		{name: "prometheus rules cut", handler: handlePrometheusRules, args: args{},
			reply: `{"available":true,"rules":[` + strings.Join(rules, ",") + `]}`, want: map[string]string{"cut": "100 of 120 rules"}},
		{name: "prometheus targets none", handler: handlePrometheusTargets, args: args{},
			reply: `{"available":true,"targets":[],"source":"targets_api"}`, want: map[string]string{"empty_reason": "lists no scrape target"}},
		{name: "prometheus targets filtered out", handler: handlePrometheusTargets, args: args{"health": "down"},
			reply: `{"available":true,"targets":[{"health":"up","job":"a"}],"source":"targets_api"}`,
			want:  map[string]string{"empty_reason": "health counts all 1 targets"}},
		{name: "loki lines cut", handler: handleLokiQuery, args: args{"logql": `{app="web"}`},
			reply: `{"resultType":"streams","lines":` + linesJSON(3) + `,"truncated":true}`,
			want:  map[string]string{"cut": "3 lines, the newest shown; the total is not known", "default_window": "the last 1h"}},
		{name: "loki series the store stopped", handler: handleLokiQuery, args: args{"logql": `sum by (pod) (count_over_time({app="web"}[5m]))`, "since_time": "6h"},
			reply: `{"resultType":"matrix","series":` + seriesJSON(3, 5) + `,"truncated":true}`,
			want:  map[string]string{"cut": "3 series shown; the total is not known (k8s-service stops", "default_window": ""}},
		{name: "loki series the store stopped, with k8s-service's count", handler: handleLokiQuery, args: args{"logql": `sum by (pod) (count_over_time({app="web"}[5m]))`, "since_time": "6h"},
			reply: `{"resultType":"matrix","series":` + seriesJSON(100, 5) + `,"truncated":true,"seriesTotal":340}`,
			want:  map[string]string{"cut": "100 of 340 series", "default_window": ""}},
		{name: "loki labels cut", handler: handleLokiLabels, args: args{"label": "app"},
			reply: `{"values":["a"],"truncated":true}`, want: map[string]string{"cut": "1 values shown", "default_window": "(since)"}},
		{name: "loki patterns", handler: handleLokiPatterns, args: args{"selector": `{app="web"}`},
			reply: `{"patterns":[],"total":0}`, want: map[string]string{"default_window": "the last 1h", "cut": ""}},
		{name: "logsearch cut", handler: handleLogSearch, args: args{"text": "error"},
			reply: `{"lines":` + linesJSON(2) + `,"truncated":true}`, want: map[string]string{"cut": "2 lines, the newest shown", "default_window": "(since)"}},
		{name: "logsearch with since", handler: handleLogSearch, args: args{"since": "6h"},
			reply: `{"lines":[]}`, want: none},
		{name: "traces search", handler: handleTracesSearch, args: args{"traceql": "{}"},
			reply: `{"traces":[]}`, want: map[string]string{"default_window": "the last 1h"}},
		{name: "trace cut", handler: handleTracesGet, args: args{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"},
			reply: `{"total":130,"hidden":10,"errors":0,"spans":[` + strings.Join(spans, ",") + `]}`,
			want:  map[string]string{"cut": "100 of 120 spans in your scope", "default_window": ""}},
		{name: "trace tags", handler: handleTracesTags, args: args{"tag": "resource.service.name"},
			reply: `{"values":[]}`, want: map[string]string{"default_window": "(since)"}},
		{name: "trace metrics cut", handler: handleTracesMetrics, args: args{"traceql": "{} | rate()"},
			// no points: the note on where points end follows the clock
			reply: `{"series":` + seriesJSON(101, 0) + `}`, want: map[string]string{"cut": "100 of 101 series", "default_window": "the last 1h"}},
		{name: "trace metrics the store stopped, with k8s-service's count", handler: handleTracesMetrics, args: args{"traceql": "{} | rate()"},
			reply: `{"series":` + seriesJSON(100, 0) + `,"truncated":true,"seriesTotal":250}`, want: map[string]string{"cut": "100 of 250 series", "default_window": "the last 1h"}},
		{name: "trace compare", handler: handleTracesCompare, args: args{"traceql": "{}", "since": "2h"},
			reply: `{"traces":0}`, want: none},
		{name: "timeline", handler: handleTimeline, args: args{"namespace": "shop"}, ordered: true,
			reply: timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0)),
			want:  map[string]string{"default_window": "the 24h before now was read"}},
		{name: "timeline with since_time", handler: handleTimeline, args: args{"namespace": "shop", "since_time": "6h"}, ordered: true,
			reply: timelineReply(t, []timelineRow{}, []timelineRow{}, timelineSummary(0, 0, 0, 0)), want: none},
	}
}

func runDetailCase(t *testing.T, c detailCase, on bool) string {
	t.Helper()
	withDetails(t, on)
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, c.reply })
	out, err := c.handler(ctxFor("c1"), c.args, bearer())
	if err != nil {
		t.Fatalf("%s: %v", c.name, err)
	}
	return out
}

// without drops the details and the window ends, which follow the clock between two calls.
func without(t *testing.T, out string) map[string]interface{} {
	t.Helper()
	m := decode(t, out)
	for _, k := range append(append([]string{}, detailKeys...), "start", "end") {
		delete(m, k)
	}
	return m
}

func TestResultDetails_OffEveryAnswerIsAsBefore(t *testing.T) {
	for _, c := range detailCases(t) {
		off := runDetailCase(t, c, false)
		for _, k := range detailKeys {
			if strings.Contains(off, `"`+k+`"`) {
				t.Fatalf("%s: off, the answer holds %s: %s", c.name, k, off)
			}
		}
		on := runDetailCase(t, c, true)
		offRest, onRest := without(t, off), without(t, on)
		if !reflect.DeepEqual(offRest, onRest) {
			t.Fatalf("%s: on changes more than the details:\noff %s\non  %s", c.name, off, on)
		}
		if c.ordered {
			continue
		}
		// a json.Marshal answer: the rest is the same bytes
		a, _ := json.Marshal(offRest)
		b, _ := json.Marshal(onRest)
		if string(a) != string(b) {
			t.Fatalf("%s: bytes differ:\n%s\n%s", c.name, a, b)
		}
	}
}

// k8s-service's seriesTotal is read for cut only: off, an answer from a k8s-service that sends it is the same bytes as
// one from a k8s-service that does not.
func TestResultDetails_OffTheSeriesTotalChangesNothing(t *testing.T) {
	window := "2026-11-15T00:00:00Z" // a fixed end, so the two answers have the same start and end
	for _, c := range []detailCase{
		{name: "loki_query", handler: handleLokiQuery, args: args{"logql": `sum by (pod) (count_over_time({app="web"}[5m]))`, "since_time": "6h", "until_time": window},
			reply: `{"resultType":"matrix","series":` + seriesJSON(100, 130) + `,"truncated":true`},
		{name: "traces_metrics", handler: handleTracesMetrics, args: args{"traceql": "{} | rate()", "since_time": "6h", "until_time": window},
			reply: `{"series":` + seriesJSON(100, 130) + `,"truncated":true`},
	} {
		before, counted := c, c
		before.reply += "}"
		counted.reply += `,"seriesTotal":340}`
		if a, b := runDetailCase(t, before, false), runDetailCase(t, counted, false); a != b {
			t.Fatalf("%s: off, seriesTotal changed the answer:\n%s\n%s", c.name, a, b)
		}
		want := "100 of 340 series; points thinned to 120 per series, of up to 130"
		if got := decode(t, runDetailCase(t, counted, true))["cut"]; got != want {
			t.Fatalf("%s: on, cut = %v, want %q", c.name, got, want)
		}
		if got := decode(t, runDetailCase(t, before, true))["cut"]; !strings.Contains(fmt.Sprint(got), "100 series shown; the total is not known") {
			t.Fatalf("%s: on without seriesTotal, cut = %v", c.name, got)
		}
	}
}

func TestResultDetails_OnSaysWhatTheAnswerHolds(t *testing.T) {
	for _, c := range detailCases(t) {
		m := decode(t, runDetailCase(t, c, true))
		for k, want := range c.want {
			got, _ := m[k].(string)
			if want == "" {
				if _, ok := m[k]; ok {
					t.Fatalf("%s: %s = %q, want none", c.name, k, got)
				}
				continue
			}
			if !strings.Contains(got, want) {
				t.Fatalf("%s: %s = %q, want it to hold %q", c.name, k, got, want)
			}
		}
	}
}

// Off unset (empty), and otherwise by the one switch rule (services/pkg/config.SwitchOn).
func TestResultDetails_OffByDefaultAndReadByTheSwitchRule(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "t": false, "true": true, " Yes ": true, "1": true, "ON": true} {
		t.Setenv("AI_TOOL_RESULT_DETAILS", v)
		if got := resultDetails(); got != want {
			t.Errorf("AI_TOOL_RESULT_DETAILS=%q: %v, want %v", v, got, want)
		}
	}
}

func TestResultDetails_TheTimelineNoteComesBeforeTheRows(t *testing.T) {
	c := detailCases(t)[len(detailCases(t))-2]
	out := runDetailCase(t, c, true)
	if i, j := strings.Index(out, `"default_window"`), strings.Index(out, `"summary"`); i < 0 || i > j {
		t.Fatalf("default_window should come before the summary: %s", out)
	}
}

func TestShortSpan(t *testing.T) {
	for in, want := range map[string]string{"1h0m0s": "1h", "24h0m0s": "24h", "30m0s": "30m", "1h30m0s": "1h30m", "45s": "45s", "later": "later"} {
		if got := spanText(in); got != want {
			t.Fatalf("spanText(%q) = %q, want %q", in, got, want)
		}
	}
}
