// TraceQL on the cluster's trace store (Tempo): search, a trace by ID,
// attribute names and values, TraceQL metrics and a fast/slow comparison —
// through k8s-service with the log search door (the caller's pods/log, the
// cluster and namespace attributes added to every spanset filter).

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	tracesCap          = 20
	traceSpansCap      = 100
	matchedSpansCap    = 5
	tracesAlternative  = "No trace store is configured for this cluster. Use logsearch / loki_query for the logs and k8s_get_events; say traces are not available here."
	traceScopeNote     = "Spans of this trace outside your scope (another cluster or namespace) are not shown"
	traceQLRefusedHint = "TraceQL may not read the parent span (parent.), the root span (rootName, rootServiceName, trace:rootService) or the whole trace's duration (traceDuration, trace:duration): they can sit outside your scope. Filter on the spans themselves."
)

// tracesGet calls a k8s-service trace path (namespaced when namespace is set)
// and decodes the reply, or returns the result the model gets when the trace
// store is missing or refuses.
func tracesGet(ctx context.Context, headers http.Header, namespace, path string, q url.Values, into interface{}) (string, bool, error) {
	if namespace != "" {
		path = "/namespaces/" + url.PathEscape(namespace) + path
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", false, err
	}
	if status != http.StatusOK {
		if d := detailOf(body); status == http.StatusBadRequest && (strings.Contains(d, "outside your scope") || strings.Contains(d, "parent.")) {
			return "", true, wrapBadRequest(d + ". " + traceQLRefusedHint)
		}
		out, ok, ferr := featureFailure("traceStore", tracesAlternative, status, body)
		if ok {
			return out, true, nil
		}
		return "", true, ferr
	}
	if err := json.Unmarshal(body, into); err != nil {
		return "", true, fmt.Errorf("trace store: unreadable reply: %w", err)
	}
	return "", false, nil
}

// tracesWindow sets start and end from since / since_time / until_time
// (default 1h back, at most 7 days — the store's own limit, 24h by default,
// refuses more).
func tracesWindow(args map[string]interface{}, q url.Values) (time.Time, time.Time, error) {
	return lokiWindow(args, q)
}

func trimMatched(traces []map[string]interface{}) {
	for _, t := range traces {
		if spans, ok := t["spans"].([]interface{}); ok && len(spans) > matchedSpansCap {
			t["spans"] = spans[:matchedSpansCap]
		}
	}
}

// handleTracesSearch runs a TraceQL search: the newest matching traces with
// the spans that matched.
func handleTracesSearch(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	traceql := strings.TrimSpace(argString(args, "traceql", ""))
	if traceql == "" {
		return "", wrapBadRequest("traceql parameter is required, e.g. { resource.service.name = \"cart\" && status = error }")
	}
	namespace := argString(args, "namespace", "")
	limit := argInt(args, "limit", tracesCap)
	if limit <= 0 || limit > tracesCap {
		limit = tracesCap
	}
	q := url.Values{"q": {traceql}, "limit": {strconv.Itoa(limit)}}
	start, end, err := tracesWindow(args, q)
	if err != nil {
		return "", wrapBadRequest(err.Error())
	}
	var reply struct {
		Traces         []map[string]interface{} `json:"traces"`
		EffectiveQuery string                   `json:"effectiveQuery"`
	}
	if out, done, err := tracesGet(ctx, headers, namespace, "/traces/search", q, &reply); done {
		return out, err
	}
	trimMatched(reply.Traces)
	result := map[string]interface{}{
		"traceql": traceql, "effective_query": reply.EffectiveQuery, "namespace": namespaceOrAll(namespace),
		"start": start.UTC().Format(time.RFC3339), "end": end.UTC().Format(time.RFC3339),
		"returned": len(reply.Traces), "traces": reply.Traces,
	}
	switch {
	case len(reply.Traces) == 0:
		result["hint"] = "No trace matched. Check attribute names and values with traces_tags, loosen the filter, or widen the window."
	case len(reply.Traces) == limit:
		result["hint"] = fmt.Sprintf("The %d newest matches; there may be more. Narrow the filter or the window, or count them with traces_metrics.", limit)
	}
	return marshalJSON(result)
}

// handleTracesGet reads one trace: the spans in the caller's cluster and
// namespace, errors first.
func handleTracesGet(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	traceID := strings.TrimSpace(argString(args, "trace_id", ""))
	if traceID == "" {
		return "", wrapBadRequest("trace_id parameter is required (up to 32 hex digits)")
	}
	namespace := argString(args, "namespace", "")
	q := url.Values{}
	if argString(args, "since_time", "") != "" || argString(args, "until_time", "") != "" {
		if _, _, err := tracesWindow(args, q); err != nil {
			return "", wrapBadRequest(err.Error())
		}
	}
	var reply struct {
		Spans     []interface{} `json:"spans"`
		Total     int           `json:"total"`
		Hidden    int           `json:"hidden"`
		Errors    int           `json:"errors"`
		Truncated bool          `json:"truncated"`
	}
	if out, done, err := tracesGet(ctx, headers, namespace, "/traces/trace/"+url.PathEscape(traceID), q, &reply); done {
		return out, err
	}
	spans := reply.Spans
	truncated := reply.Truncated
	if len(spans) > traceSpansCap {
		spans, truncated = spans[:traceSpansCap], true
	}
	result := map[string]interface{}{
		"trace_id": traceID, "namespace": namespaceOrAll(namespace), "spans": spans,
		"shown": len(spans), "errors": reply.Errors,
	}
	if reply.Hidden > 0 {
		result["hidden"] = reply.Hidden
		result["note"] = fmt.Sprintf("%s (%d of %d).", traceScopeNote, reply.Hidden, reply.Total)
	}
	if truncated {
		result["truncated"] = true
		result["hint"] = "Errors come first, then by start time; the rest of the spans is cut."
	}
	return marshalJSON(result)
}

// handleTracesTags lists attribute names by scope, or one attribute's values.
func handleTracesTags(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	q := url.Values{}
	scope := strings.TrimSpace(argString(args, "scope", ""))
	tag := strings.TrimSpace(argString(args, "tag", ""))
	if scope != "" {
		q.Set("scope", scope)
	}
	if tag != "" {
		q.Set("tag", tag)
	}
	if _, _, err := tracesWindow(args, q); err != nil {
		return "", wrapBadRequest(err.Error())
	}
	var reply map[string]interface{}
	if out, done, err := tracesGet(ctx, headers, namespace, "/traces/tags", q, &reply); done {
		return out, err
	}
	reply["namespace"] = namespaceOrAll(namespace)
	if tag == "" {
		reply["note"] = "Use a name with its scope in TraceQL: resource.service.name, span.http.route; intrinsics (name, status, duration, kind) need no scope."
	}
	if values, ok := reply["values"].([]interface{}); ok && len(values) == 0 {
		reply["hint"] = "No value in the window: widen since, or check the name with traces_tags without tag."
	}
	return marshalJSON(reply)
}

// handleTracesMetrics runs a TraceQL metrics query (rate(), count_over_time(),
// quantile_over_time(duration, .95) … by (…)) as series, in prometheus_query's
// range shape.
func handleTracesMetrics(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	traceql := strings.TrimSpace(argString(args, "traceql", ""))
	if traceql == "" {
		return "", wrapBadRequest("traceql parameter is required, e.g. { status = error } | rate() by (resource.service.name)")
	}
	namespace := argString(args, "namespace", "")
	q := url.Values{"q": {traceql}}
	start, end, err := tracesWindow(args, q)
	if err != nil {
		return "", wrapBadRequest(err.Error())
	}
	step := argInt(args, "step", 0)
	if step <= 0 {
		step = int(end.Sub(start).Seconds()) / promPointsCap
	}
	step = max(step, promMinStepSecond)
	q.Set("step", strconv.Itoa(step))
	var reply struct {
		Series         []map[string]interface{} `json:"series"`
		Truncated      bool                     `json:"truncated"`
		EffectiveQuery string                   `json:"effectiveQuery"`
	}
	if out, done, err := tracesGet(ctx, headers, namespace, "/traces/metrics", q, &reply); done {
		return out, err
	}
	truncated := reply.Truncated
	results := reply.Series
	if len(results) > promSeriesCap {
		results, truncated = results[:promSeriesCap], true
	}
	for _, r := range results {
		if pts, ok := r["points"].([]interface{}); ok && len(pts) > promPointsCap {
			r["points"], truncated = thin(pts, promPointsCap), true
		}
	}
	result := map[string]interface{}{
		"traceql": traceql, "effective_query": reply.EffectiveQuery, "namespace": namespaceOrAll(namespace),
		"kind": "metric", "range": true, "series": len(reply.Series), "results": results, "step_seconds": step,
		"start": start.UTC().Format(time.RFC3339), "end": end.UTC().Format(time.RFC3339),
	}
	if len(reply.Series) == 0 {
		result["hint"] = "No series: no span matched. Check names with traces_tags, or widen the window."
	}
	if last := lastPointTime(results); last > 0 && end.Unix()-int64(last) >= 120 {
		result["note"] = fmt.Sprintf("Points end at %s: the trace store leaves the newest spans out of TraceQL metrics (its end cutoff, 30 s by default, rounded down to whole steps). For the last %d minutes use traces_search or a shorter window.",
			time.Unix(int64(last), 0).UTC().Format(time.RFC3339), (end.Unix()-int64(last)+59)/60)
	}
	if truncated {
		result["truncated"] = true
		result["hint"] = "The result is cut: do not answer from it. Group by fewer attributes or add filters, then query again."
	}
	return marshalJSON(result)
}

// lastPointTime is the latest point time (unix seconds) over the series, 0 without points.
func lastPointTime(series []map[string]interface{}) float64 {
	var last float64
	for _, s := range series {
		pts, _ := s["points"].([]interface{})
		for _, p := range pts {
			if m, ok := p.(map[string]interface{}); ok {
				if t, ok := m["t"].(float64); ok && t > last {
					last = t
				}
			}
		}
	}
	return last
}

// handleTracesCompare sums up how long matching spans took over the newest
// matching traces, with the fastest, typical and slowest samples.
func handleTracesCompare(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	traceql := strings.TrimSpace(argString(args, "traceql", ""))
	if traceql == "" {
		return "", wrapBadRequest("traceql parameter is required, e.g. { resource.service.name = \"cart\" && kind = server }")
	}
	namespace := argString(args, "namespace", "")
	q := url.Values{"q": {traceql}}
	if limit := argInt(args, "limit", 0); limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if _, _, err := tracesWindow(args, q); err != nil {
		return "", wrapBadRequest(err.Error())
	}
	var reply map[string]interface{}
	if out, done, err := tracesGet(ctx, headers, namespace, "/traces/compare", q, &reply); done {
		return out, err
	}
	for _, group := range []string{"fastest", "typical", "slowest"} {
		if samples, ok := reply[group].([]interface{}); ok {
			for _, s := range samples {
				if m, ok := s.(map[string]interface{}); ok {
					if spans, ok := m["spans"].([]interface{}); ok && len(spans) > 2 {
						m["spans"] = spans[:2]
					}
				}
			}
		}
	}
	reply["namespace"] = namespaceOrAll(namespace)
	reply["traceql"] = traceql
	reply["note"] = "Durations are of the slowest matched span per trace (the whole trace may reach outside your scope). Open a sample with traces_get to see where the time went."
	if n, _ := reply["traces"].(float64); n == 0 {
		reply["hint"] = "No trace matched: loosen the filter or widen the window."
	}
	return marshalJSON(reply)
}
