// LogQL on the cluster's log store: a query (lines, or series for a metric
// query), label names and values, and log patterns — through k8s-service with
// the structured search's door (the caller's pods/log, the cluster and
// namespace matchers added to every selector).

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
	lokiPatternsCap     = 20
	lokiPatternTextCap  = 300
	patternsAlternative = "This log store keeps no patterns (Loki needs pattern_ingester.enabled). Count line shapes with loki_query instead, e.g. sum by (k8s_pod_name) (count_over_time({k8s_namespace_name=\"<ns>\"} |= \"error\" [5m]))."
)

// lokiGet calls a k8s-service log store path (namespaced when namespace is
// set) and decodes the reply, or returns the result the model gets when log
// search is missing or refuses.
func lokiGet(ctx context.Context, headers http.Header, namespace, path string, q url.Values, alternative string, into interface{}) (string, bool, error) {
	if namespace != "" {
		path = "/namespaces/" + url.PathEscape(namespace) + path
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", false, err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("logSearch", alternative, status, body)
		if ok {
			return out, true, nil
		}
		return "", true, ferr
	}
	if err := json.Unmarshal(body, into); err != nil {
		return "", true, fmt.Errorf("log store: unreadable reply: %w", err)
	}
	return "", false, nil
}

// lokiWindow sets start and end on q from since / since_time / until_time
// (the prometheus_query rules: default 1h, at most 7 days — the log store's
// own limit, 24h by default, refuses more).
func lokiWindow(args map[string]interface{}, q url.Values) (time.Time, time.Time, error) {
	start, end, err := promWindow(argString(args, "since", ""), argString(args, "since_time", ""), argString(args, "until_time", ""), time.Now())
	if err != nil {
		return start, end, err
	}
	q.Set("start", start.UTC().Format(time.RFC3339))
	q.Set("end", end.UTC().Format(time.RFC3339))
	return start, end, nil
}

// handleLokiQuery runs LogQL: a log query returns the newest lines, a metric
// query (count_over_time, rate, sum by …) one series per label set.
func handleLokiQuery(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	logql := strings.TrimSpace(argString(args, "logql", ""))
	if logql == "" {
		return "", wrapBadRequest("logql parameter is required")
	}
	namespace := argString(args, "namespace", "")
	q := url.Values{"q": {logql}}
	start, end, err := lokiWindow(args, q)
	if err != nil {
		return "", wrapBadRequest(err.Error())
	}
	step := argInt(args, "step", 0)
	if step <= 0 {
		step = int(end.Sub(start).Seconds()) / promPointsCap
	}
	step = max(step, promMinStepSecond)
	q.Set("step", strconv.Itoa(step))
	limit := argInt(args, "limit", 100)
	if limit <= 0 || limit > logLinesCap {
		limit = min(max(limit, 100), logLinesCap)
	}
	q.Set("limit", strconv.Itoa(limit))

	var reply struct {
		ResultType     string                   `json:"resultType"`
		EffectiveQuery string                   `json:"effectiveQuery"`
		Lines          []interface{}            `json:"lines"`
		Series         []map[string]interface{} `json:"series"`
		Truncated      bool                     `json:"truncated"`
		Oldest         string                   `json:"oldest"`
		Newest         string                   `json:"newest"`
	}
	if out, done, err := lokiGet(ctx, headers, namespace, "/logsearch/logql", q, logAlternative, &reply); done {
		return out, err
	}
	result := map[string]interface{}{
		"logql":           logql,
		"effective_query": reply.EffectiveQuery,
		"namespace":       namespaceOrAll(namespace),
		"start":           start.UTC().Format(time.RFC3339),
		"end":             end.UTC().Format(time.RFC3339),
	}
	truncated := reply.Truncated
	if reply.ResultType == "matrix" {
		results := reply.Series
		if len(results) > promSeriesCap {
			results, truncated = results[:promSeriesCap], true
		}
		for _, r := range results {
			if pts, ok := r["points"].([]interface{}); ok && len(pts) > promPointsCap {
				r["points"], truncated = thin(pts, promPointsCap), true
			}
		}
		result["kind"], result["range"], result["series"], result["results"], result["step_seconds"] = "metric", true, len(reply.Series), results, step
		switch {
		case len(reply.Series) == 0:
			result["hint"] = "No series: no line matched. Check the label names and values with loki_labels, or widen the window."
		case !truncated:
			result["note"] = "A step with no matching line has no point; read it as 0 for counts and rates."
		}
	} else {
		lines := reply.Lines
		if len(lines) > limit {
			lines, truncated = lines[:limit], true
		}
		result["kind"], result["returned"], result["lines"] = "log", len(lines), lines
		if reply.Oldest != "" {
			result["oldest"], result["newest"] = reply.Oldest, reply.Newest
		}
		if len(lines) == 0 {
			result["hint"] = "No line matched. Check the label names and values with loki_labels, loosen the line filter, or widen the window."
		}
	}
	if truncated {
		result["truncated"] = true
		result["hint"] = "The result is cut: do not answer from it. Aggregate (sum by (…), topk(10, …)), add matchers or narrow the window, then query again."
	}
	return marshalJSON(result)
}

// handleLokiLabels lists the label names on the cluster's (namespace's)
// streams, or one label's values.
func handleLokiLabels(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	q := url.Values{}
	label := strings.TrimSpace(argString(args, "label", ""))
	if label != "" {
		q.Set("label", label)
	}
	if _, _, err := lokiWindow(args, q); err != nil {
		return "", wrapBadRequest(err.Error())
	}
	var reply struct {
		Values    []string `json:"values"`
		Truncated bool     `json:"truncated"`
	}
	if out, done, err := lokiGet(ctx, headers, namespace, "/logsearch/labels", q, logAlternative, &reply); done {
		return out, err
	}
	result := map[string]interface{}{"namespace": namespaceOrAll(namespace), "values": reply.Values}
	if label != "" {
		result["label"] = label
	}
	switch {
	case reply.Truncated:
		result["truncated"] = true
		result["hint"] = "More values than listed: match the ones you need with a regex matcher (label=~\"web-.*\") instead of listing them."
	case len(reply.Values) == 0:
		result["hint"] = "Nothing in the window: widen since, or check the namespace."
	}
	return marshalJSON(result)
}

// handleLokiPatterns groups the selected streams' lines into patterns (the
// variable parts as <_>), most lines first.
func handleLokiPatterns(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	selector := strings.TrimSpace(argString(args, "selector", ""))
	if selector == "" {
		return "", wrapBadRequest("selector parameter is required (a stream selector such as {k8s_container_name=\"web\"})")
	}
	namespace := argString(args, "namespace", "")
	q := url.Values{"q": {selector}}
	if _, _, err := lokiWindow(args, q); err != nil {
		return "", wrapBadRequest(err.Error())
	}
	var reply struct {
		Patterns       []map[string]interface{} `json:"patterns"`
		Total          int                      `json:"total"`
		EffectiveQuery string                   `json:"effectiveQuery"`
	}
	if out, done, err := lokiGet(ctx, headers, namespace, "/logsearch/patterns", q, patternsAlternative, &reply); done {
		return out, err
	}
	patterns := reply.Patterns
	if len(patterns) > lokiPatternsCap {
		patterns = patterns[:lokiPatternsCap]
	}
	for _, p := range patterns {
		if s, ok := p["pattern"].(string); ok {
			if r := []rune(s); len(r) > lokiPatternTextCap {
				p["pattern"] = string(r[:lokiPatternTextCap]) + "…"
			}
		}
	}
	result := map[string]interface{}{
		"selector": selector, "effective_query": reply.EffectiveQuery, "namespace": namespaceOrAll(namespace),
		"total": reply.Total, "patterns": patterns,
	}
	switch {
	case reply.Total > len(patterns):
		result["hint"] = fmt.Sprintf("The %d most frequent of %d patterns. To see the lines of one, loki_query with a line filter on its fixed text.", len(patterns), reply.Total)
	case reply.Total == 0:
		result["hint"] = "No patterns in the window: Loki lists a pattern only once 30 lines have it, keeps recent lines only (3h by default), or no line matched. Widen since, or count lines with loki_query."
	}
	return marshalJSON(result)
}
