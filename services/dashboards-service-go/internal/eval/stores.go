package eval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// LogQL and TraceQL are read by their surface (Loki and Tempo are AGPL, so
// their parsers are not imported): enough to tell a selector, its labels and
// a metric query from a log query. The store itself judges the rest when the
// query runs.

var (
	logSelector  = regexp.MustCompile(`\{[^{}]*\}`)
	logMatcher   = regexp.MustCompile(`([A-Za-z_][A-Za-z0-9_.]*)\s*(=~|!~|!=|=)\s*"`)
	logRangeAggs = regexp.MustCompile(`\b(count_over_time|rate|rate_counter|bytes_over_time|bytes_rate|sum_over_time|avg_over_time|max_over_time|min_over_time|first_over_time|last_over_time|stdvar_over_time|stddev_over_time|quantile_over_time|absent_over_time)\s*\(`)
	traceMetric  = regexp.MustCompile(`\|\s*(rate|count_over_time|min_over_time|max_over_time|avg_over_time|sum_over_time|quantile_over_time|histogram_over_time|compare)\s*\(`)
	callName     = regexp.MustCompile(`\b([a-z_]+)\s*\(`)
)

// textFacts is what a LogQL or TraceQL query has.
type textFacts struct {
	selectors int
	labels    map[string]bool // matcher names (LogQL labels, TraceQL attributes)
	metric    bool            // a metric query, not log lines or traces
	functions map[string]bool
	text      string
}

func analyseLog(expr string) textFacts {
	f := textFacts{labels: map[string]bool{}, functions: map[string]bool{}, text: expr}
	for _, sel := range logSelector.FindAllString(expr, -1) {
		f.selectors++
		for _, m := range logMatcher.FindAllStringSubmatch(sel, -1) {
			f.labels[m[1]] = true
		}
	}
	f.metric = logRangeAggs.MatchString(expr)
	for _, m := range callName.FindAllStringSubmatch(expr, -1) {
		f.functions[m[1]] = true
	}
	return f
}

func analyseTrace(expr string) textFacts {
	f := textFacts{labels: map[string]bool{}, functions: map[string]bool{}, text: expr}
	for _, sel := range logSelector.FindAllString(expr, -1) {
		f.selectors++
		for _, m := range logMatcher.FindAllStringSubmatch(sel, -1) {
			f.labels[m[1]] = true
		}
		for _, w := range []string{"duration", "status", "name", "kind"} {
			if regexp.MustCompile(`\b` + w + `\s*(=|!=|>|<|>=|<=)`).MatchString(sel) {
				f.labels[w] = true
			}
		}
	}
	f.metric = traceMetric.MatchString(expr)
	for _, m := range callName.FindAllStringSubmatch(expr, -1) {
		f.functions[m[1]] = true
	}
	return f
}

// Stores are the stores grading runs queries on; a nil one is not used.
type Stores struct {
	Prometheus Querier
	Loki       LogQuerier
	Tempo      TraceQuerier
}

func (s Stores) live() bool { return s.Prometheus != nil || s.Loki != nil || s.Tempo != nil }

// LogQuerier runs LogQL over the last hour: a metric query counts its series
// with a value, a log query its lines.
type LogQuerier interface {
	Query(ctx context.Context, expr string, metric bool) (int, error)
	Labels(ctx context.Context) ([]string, error)
}

// TraceQuerier runs TraceQL over the last hour: a search counts its traces, a
// metric query its series with a sample above zero.
type TraceQuerier interface {
	Query(ctx context.Context, expr string, metric bool) (int, error)
}

func getJSON(ctx context.Context, c *http.Client, u string, out any) error {
	if c == nil {
		c = &http.Client{Timeout: 20 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body[:min(len(body), 300)])))
	}
	return json.Unmarshal(body, out)
}

// Loki is a LogQuerier on Loki's HTTP API.
type Loki struct {
	Base   string
	Client *http.Client
	Now    func() time.Time
}

func (l Loki) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

func (l Loki) Query(ctx context.Context, expr string, metric bool) (int, error) {
	end := l.now()
	params := url.Values{"query": {expr}, "start": {strconv.FormatInt(end.Add(-time.Hour).UnixNano(), 10)},
		"end": {strconv.FormatInt(end.UnixNano(), 10)}, "limit": {"50"}}
	if metric {
		params.Set("step", "60s")
	}
	var out struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Values [][2]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := getJSON(ctx, l.Client, strings.TrimRight(l.Base, "/")+"/loki/api/v1/query_range?"+params.Encode(), &out); err != nil {
		return 0, err
	}
	if out.Status != "success" {
		return 0, fmt.Errorf("loki: %s", out.Status)
	}
	n := 0
	for _, r := range out.Data.Result {
		if metric {
			if len(r.Values) > 0 {
				n++
			}
		} else {
			n += len(r.Values)
		}
	}
	return n, nil
}

func (l Loki) Labels(ctx context.Context) ([]string, error) {
	var out struct {
		Data []string `json:"data"`
	}
	end := l.now()
	params := url.Values{"start": {strconv.FormatInt(end.Add(-time.Hour).UnixNano(), 10)}, "end": {strconv.FormatInt(end.UnixNano(), 10)}}
	err := getJSON(ctx, l.Client, strings.TrimRight(l.Base, "/")+"/loki/api/v1/labels?"+params.Encode(), &out)
	return out.Data, err
}

// Tempo is a TraceQuerier on Tempo's HTTP API.
type Tempo struct {
	Base   string
	Client *http.Client
	Now    func() time.Time
}

func (t Tempo) Query(ctx context.Context, expr string, metric bool) (int, error) {
	end := time.Now()
	if t.Now != nil {
		end = t.Now()
	}
	start := end.Add(-time.Hour)
	base := strings.TrimRight(t.Base, "/")
	if !metric {
		var out struct {
			Traces []json.RawMessage `json:"traces"`
		}
		params := url.Values{"q": {expr}, "start": {strconv.FormatInt(start.Unix(), 10)}, "end": {strconv.FormatInt(end.Unix(), 10)}, "limit": {"50"}}
		if err := getJSON(ctx, t.Client, base+"/api/search?"+params.Encode(), &out); err != nil {
			return 0, err
		}
		return len(out.Traces), nil
	}
	var out struct {
		Series []struct {
			Samples []struct {
				Value float64 `json:"value"`
			} `json:"samples"`
		} `json:"series"`
	}
	params := url.Values{"q": {expr}, "start": {strconv.FormatInt(start.Unix(), 10)}, "end": {strconv.FormatInt(end.Unix(), 10)}, "step": {"60s"}}
	if err := getJSON(ctx, t.Client, base+"/api/metrics/query_range?"+params.Encode(), &out); err != nil {
		return 0, err
	}
	n := 0
	for _, s := range out.Series {
		for _, v := range s.Samples {
			if v.Value > 0 {
				n++
				break
			}
		}
	}
	return n, nil
}

// SeedService names the evaluation's own traces and logs.
const SeedService = "kubeast-eval-shop"

// SeedLogs pushes the evaluation's log lines: 120 over the last ten minutes,
// a shop whose /pay route fails a third of the time, and one line inside each
// seeded trace's server span (SeedTraces with the same now) carrying the
// trace's trace_id and span_id as structured metadata, as an OpenTelemetry
// SDK writes them — what a trace-to-logs link finds.
func SeedLogs(ctx context.Context, lokiBase string, now time.Time) error {
	type stream struct {
		Stream map[string]string `json:"stream"`
		Values [][]any           `json:"values"`
	}
	s := stream{Stream: map[string]string{
		"k8s_cluster_name": "kubeast-b", "k8s_namespace_name": "kubeast-eval", "k8s_pod_name": "shop-7c9f5-x2kq4",
		"k8s_container_name": "shop", "service_name": SeedService,
	}}
	for i := 0; i < 120; i++ {
		at := now.Add(-10 * time.Minute).Add(time.Duration(i) * 5 * time.Second)
		route, level, msg := seedRoute(i)
		switch level {
		case "ERROR":
			msg = "payment failed: card declined"
		case "WARN":
			msg = "slow checkout"
		}
		s.Values = append(s.Values, []any{strconv.FormatInt(at.UnixNano(), 10),
			fmt.Sprintf("level=%s route=%s msg=%q", level, route, msg)})
	}
	for i := 0; i < seedTraces; i++ {
		start, _, route, level := seedSpan(now, i)
		msg := map[string]string{"/cart": "cart shown", "/checkout": "checked out", "/pay": "paid"}[route]
		if level == "ERROR" {
			msg = "payment failed: card declined"
		}
		s.Values = append(s.Values, []any{strconv.FormatInt(start.Add(10*time.Millisecond).UnixNano(), 10),
			fmt.Sprintf("level=%s route=%s msg=%q", level, route, msg),
			map[string]string{"trace_id": seedTraceID(now, i), "span_id": seedSpanID(i)}})
	}
	body, _ := json.Marshal(map[string]any{"streams": []stream{s}})
	return post(ctx, strings.TrimRight(lokiBase, "/")+"/loki/api/v1/push", body)
}

// seedRoute: every third request /pay (one in three of those fails), the
// rest /cart and /checkout (slow).
func seedRoute(i int) (route, level, msg string) {
	switch {
	case i%3 == 0 && i%9 == 0:
		return "/pay", "ERROR", ""
	case i%3 == 0:
		return "/pay", "INFO", "paid"
	case i%3 == 1:
		return "/cart", "INFO", "cart shown"
	case i%6 == 2:
		return "/checkout", "WARN", ""
	}
	return "/checkout", "INFO", "checked out"
}

// SeedTraces sends the evaluation's traces (OTLP/HTTP JSON) for the last 90
// seconds: /cart fast, /checkout over a second, /pay failing a third of the
// time, each a server span with a database child. Tempo searches a span by
// its time only within ingestion_time_range_slack (2m by default) of when it
// arrived, so the traces end before now and start no earlier than 90 s ago;
// their ids carry the run's time, so a second run makes new traces.
func SeedTraces(ctx context.Context, otlpBase string, now time.Time) error {
	attr := func(k, v string) map[string]any {
		return map[string]any{"key": k, "value": map[string]any{"stringValue": v}}
	}
	var spans []map[string]any
	for i := 0; i < seedTraces; i++ {
		start, dur, route, level := seedSpan(now, i)
		trace, root := seedTraceID(now, i), seedSpanID(i)
		status := map[string]any{"code": 1}
		if level == "ERROR" {
			status = map[string]any{"code": 2, "message": "card declined"}
		}
		spans = append(spans, map[string]any{
			"traceId": trace, "spanId": root, "name": "GET " + route, "kind": 2,
			"startTimeUnixNano": strconv.FormatInt(start.UnixNano(), 10), "endTimeUnixNano": strconv.FormatInt(start.Add(dur).UnixNano(), 10),
			"attributes": []any{attr("http.route", route), attr("http.request.method", "GET")}, "status": status,
		}, map[string]any{
			"traceId": trace, "spanId": fmt.Sprintf("%016x", 0xb000+i), "parentSpanId": root, "name": "db query", "kind": 3,
			"startTimeUnixNano": strconv.FormatInt(start.Add(5*time.Millisecond).UnixNano(), 10),
			"endTimeUnixNano":   strconv.FormatInt(start.Add(dur-5*time.Millisecond).UnixNano(), 10),
			"attributes":        []any{attr("db.system", "postgresql")},
		})
	}
	body, _ := json.Marshal(map[string]any{"resourceSpans": []any{map[string]any{
		"resource": map[string]any{"attributes": []any{attr("service.name", SeedService),
			attr("k8s.cluster.name", "kubeast-b"), attr("k8s.namespace.name", "kubeast-eval")}},
		"scopeSpans": []any{map[string]any{"scope": map[string]any{"name": "kubeast-eval"}, "spans": spans}},
	}}})
	return post(ctx, strings.TrimRight(otlpBase, "/")+"/v1/traces", body)
}

// seedTraces is how many traces SeedTraces sends.
const seedTraces = 60

// seedSpan is trace i's server span: its start, duration, route and level.
func seedSpan(now time.Time, i int) (start time.Time, dur time.Duration, route, level string) {
	start = now.Add(-90 * time.Second).Add(time.Duration(i) * 1450 * time.Millisecond)
	route, level, _ = seedRoute(i)
	dur = 80 * time.Millisecond
	switch route {
	case "/checkout":
		dur = time.Duration(1100+(i%5)*100) * time.Millisecond
	case "/pay":
		dur = 300 * time.Millisecond
	}
	return start, dur, route, level
}

// seedTraceID carries the run's time, so a second run makes new traces.
func seedTraceID(now time.Time, i int) string { return fmt.Sprintf("%016x%016x", now.Unix(), i) }

func seedSpanID(i int) string { return fmt.Sprintf("%016x", 0xa000+i) }

func post(ctx context.Context, u string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("%s: HTTP %d %s", u, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}
