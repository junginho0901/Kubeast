// Feature tools read what Kubeast already computes — Prometheus through
// k8s-service, the log store, the issue check — instead of running kubectl.
// Each call goes to k8s-service with the caller's own token and the routed
// cluster, so k8s-service applies its permission checks and writes its audit
// rows as for the screen; this side only holds ai.tool.<name>. A refusal or a
// missing feature comes back as a result the model can act on.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

var featureHTTP = &http.Client{Timeout: 45 * time.Second}

const (
	promSeriesCap     = 100
	promPointsCap     = 120
	logLinesCap       = 200
	issuesCap         = 200
	featureBodyCap    = 8 << 20
	promMinStepSecond = 15
)

// k8sServiceGet calls one k8s-service API for the routed cluster as the caller.
func k8sServiceGet(ctx context.Context, headers http.Header, path string, q url.Values) (int, []byte, error) {
	if q == nil {
		q = url.Values{}
	}
	q.Set("cluster", clusterIDFromCtx(ctx))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k8sServiceURL+"/api/v1"+path+"?"+q.Encode(), nil)
	if err != nil {
		return 0, nil, err
	}
	if auth := headers.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := doTraced(featureHTTP, req)
	if err != nil {
		return 0, nil, fmt.Errorf("k8s-service %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, featureBodyCap))
	if err != nil {
		return 0, nil, fmt.Errorf("k8s-service %s: %w", path, err)
	}
	return resp.StatusCode, body, nil
}

// doTraced sends a k8s-service request; for a tool call being recorded it asks
// for the cluster requests k8s-service makes and adds them to the call's trail.
func doTraced(client *http.Client, req *http.Request) (*http.Response, error) {
	rec := accesstrail.FromContext(req.Context())
	if rec != nil {
		req.Header.Set(accesstrail.HeaderRecord, "1")
	}
	resp, err := client.Do(req)
	if rec != nil && resp != nil {
		if trail, ok := accesstrail.ParseHeader(resp.Header.Get(accesstrail.HeaderRequests)); ok {
			rec.Merge(trail)
		}
	}
	return resp, err
}

// detailOf reads k8s-service's {"detail": …} / {"error": …} message.
func detailOf(body []byte) string {
	var m map[string]interface{}
	if json.Unmarshal(body, &m) == nil {
		for _, k := range []string{"detail", "error", "message"} {
			if s, ok := m[k].(string); ok && s != "" {
				return s
			}
		}
	}
	return strings.TrimSpace(string(body))
}

// featureFailure maps a k8s-service refusal to a JSON result; ok is false for
// an error that is not the model's to handle.
func featureFailure(feature, alternative string, status int, body []byte) (string, bool, error) {
	detail := detailOf(body)
	var result map[string]interface{}
	switch {
	case status == http.StatusNotFound && featureMissing(detail):
		result = map[string]interface{}{"status": "unavailable", "feature": feature, "reason": detail, "alternative": alternative}
	case status == http.StatusNotFound && strings.Contains(strings.ToLower(detail), "not found") && !strings.Contains(strings.ToLower(detail), "cluster not found"):
		result = map[string]interface{}{"status": "not_found", "feature": feature, "reason": detail,
			"hint": "The named object does not exist here. List first (what=list / k8s_find_resource) instead of guessing names."}
	case status == http.StatusForbidden:
		result = map[string]interface{}{"status": "forbidden", "feature": feature, "reason": detail,
			"hint": "Your grant does not reach this. Tell the user what was refused instead of trying another way."}
	case status == http.StatusTooManyRequests:
		result = map[string]interface{}{"status": "rate_limited", "feature": feature, "reason": detail,
			"hint": "Too many calls in a minute. Do not retry now; answer with what you already have."}
	case status == http.StatusBadRequest:
		return "", false, wrapBadRequest(detail)
	default:
		return "", false, fmt.Errorf("k8s-service %s: status %d: %s", feature, status, detail)
	}
	out, err := marshalJSON(result)
	return out, err == nil, err
}

// featureMissing: k8s-service's 404 says the feature, not an object, is absent.
func featureMissing(detail string) bool {
	d := strings.ToLower(detail)
	for _, phrase := range []string{"not configured", "disabled", "is off", "opencost not found", "not installed", "not served"} {
		if strings.Contains(d, phrase) {
			return true
		}
	}
	return false
}

func unavailableResult(feature, reason, alternative string) (string, error) {
	return marshalJSON(map[string]interface{}{"status": "unavailable", "feature": feature, "reason": reason, "alternative": alternative})
}

const (
	promAlternative = "No Prometheus is reachable for this cluster. Use get_pod_metrics / get_node_metrics (metrics-server) for current usage, k8s_describe_resource for requests and limits, and say that history is unavailable here."
	logAlternative  = "Log search is not configured for this cluster. Use k8s_get_pod_logs (the pod must still exist; previous=true for a restarted container) and k8s_get_events."
)

// handlePrometheusQuery runs PromQL through k8s-service: an instant query, or
// a range over `since` when range=true. The cluster's own Prometheus (or the
// external store with the cluster's label) answers; results are capped.
func handlePrometheusQuery(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	promql := strings.TrimSpace(argString(args, "promql", ""))
	if promql == "" {
		return "", wrapBadRequest("promql parameter is required")
	}
	q := url.Values{"query": {promql}}
	path := "/prometheus/query"
	sinceTime, untilTime := argString(args, "since_time", ""), argString(args, "until_time", "")
	isRange := argBool(args, "range") || sinceTime != "" || untilTime != ""
	var since time.Duration
	var start, end time.Time
	step := 0
	if isRange {
		var err error
		if start, end, err = promWindow(argString(args, "since", ""), sinceTime, untilTime, time.Now()); err != nil {
			return "", wrapBadRequest(err.Error())
		}
		since = end.Sub(start)
		step = argInt(args, "step", 0)
		if step <= 0 {
			step = int(since.Seconds()) / promPointsCap
		}
		if step < promMinStepSecond {
			step = promMinStepSecond
		}
		q.Set("start", strconv.FormatInt(start.Unix(), 10))
		q.Set("end", strconv.FormatInt(end.Unix(), 10))
		q.Set("step", strconv.Itoa(step))
		path = "/prometheus/query_range"
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("prometheus", promAlternative, status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	var reply struct {
		Available bool                     `json:"available"`
		Results   []map[string]interface{} `json:"results"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("prometheus: unreadable reply: %w", err)
	}
	if !reply.Available {
		return unavailableResult("prometheus", "no Prometheus is reachable for this cluster", promAlternative)
	}
	truncated := false
	results := reply.Results
	if len(results) > promSeriesCap {
		results = results[:promSeriesCap]
		truncated = true
	}
	if isRange {
		for _, r := range results {
			if pts, ok := r["points"].([]interface{}); ok && len(pts) > promPointsCap {
				r["points"] = thin(pts, promPointsCap)
				truncated = true
			}
		}
	}
	result := map[string]interface{}{
		"promql":  promql,
		"range":   isRange,
		"series":  len(reply.Results),
		"results": results,
	}
	if isRange {
		result["since"] = since.String()
		result["start"] = start.UTC().Format(time.RFC3339)
		result["end"] = end.UTC().Format(time.RFC3339)
		result["step_seconds"] = step
	}
	if truncated {
		result["truncated"] = true
		result["hint"] = "The result is cut: do not answer from it. Aggregate (sum by (…), topk(10, …)) or add matchers and query again."
	}
	if len(reply.Results) == 0 {
		result["hint"] = "The query matched no series. Find the metric with prometheus_metrics and its labels with prometheus_labels instead of guessing (the cluster may not run the exporter that produces it)."
	}
	return marshalJSON(result)
}

// promWindow is a range query's span: since_time (24h, 7d or an RFC3339 time)
// to until_time (RFC3339, default now), else since (a duration, default 1h)
// back from now; at most 7 days.
func promWindow(since, sinceTime, untilTime string, now time.Time) (time.Time, time.Time, error) {
	end := now
	if untilTime != "" {
		t, err := time.Parse(time.RFC3339, untilTime)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("until_time must be an RFC3339 time")
		}
		end = t
	}
	var start time.Time
	switch {
	case sinceTime != "":
		t, err := parseFromTime(sinceTime, end)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("since_time: %v", err)
		}
		start = t
	default:
		d, _ := time.ParseDuration(since)
		if d <= 0 {
			d = time.Hour
		}
		start = end.Add(-d)
	}
	if !start.Before(end) {
		return time.Time{}, time.Time{}, fmt.Errorf("since_time must be before until_time")
	}
	if end.Sub(start) > 7*24*time.Hour {
		return time.Time{}, time.Time{}, fmt.Errorf("a range of at most 7 days")
	}
	return start, end, nil
}

// thin keeps at most n points of a series, evenly spaced, the last one always.
func thin(points []interface{}, n int) []interface{} {
	if len(points) <= n || n < 2 {
		return points
	}
	out := make([]interface{}, 0, n)
	for i := 0; i < n-1; i++ {
		out = append(out, points[i*len(points)/(n-1)])
	}
	return append(out, points[len(points)-1])
}

// handleLogSearch searches the cluster's log store (structured search, not
// LogQL) through k8s-service, which asks the cluster whether the caller may
// read pod logs there before anything is read.
func handleLogSearch(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	q := url.Values{}
	for arg, param := range map[string]string{"text": "q", "pod": "pod", "container": "container", "workload_kind": "workload_kind", "workload_name": "workload_name"} {
		if v := strings.TrimSpace(argString(args, arg, "")); v != "" {
			q.Set(param, v)
		}
	}
	q.Set("since", argString(args, "since", "1h"))
	limit := argInt(args, "limit", 100)
	if limit <= 0 {
		limit = 100
	}
	if limit > logLinesCap {
		limit = logLinesCap
	}
	q.Set("limit", strconv.Itoa(limit))
	q.Set("ignore_case", "true")
	if argBool(args, "regex") {
		q.Set("match", "regex")
	}
	path := "/logsearch"
	if namespace != "" {
		path = "/namespaces/" + url.PathEscape(namespace) + "/logsearch"
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("logSearch", logAlternative, status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	var reply map[string]interface{}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("logsearch: unreadable reply: %w", err)
	}
	if lines, ok := reply["lines"].([]interface{}); ok {
		reply["returned"] = len(lines)
		if len(lines) > limit {
			reply["lines"] = lines[:limit]
			reply["truncated"] = true
		}
		if len(lines) == 0 {
			reply["hint"] = "No log line matched in the window. Widen since, drop the text filter, or check the pod/workload name with k8s_find_resource."
		}
	}
	reply["namespace"] = namespaceOrAll(namespace)
	return marshalJSON(reply)
}

func namespaceOrAll(namespace string) string {
	if namespace == "" {
		return "all namespaces"
	}
	return namespace
}

// handleIssues returns the dashboard's issue check — pods, workloads, nodes,
// PVCs and Warning events in one pass — narrowed to a namespace, the caller's
// granted namespaces, or a severity.
func handleIssues(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	severity := strings.ToLower(argString(args, "severity", ""))
	q := url.Values{}
	if w := argInt(args, "window_minutes", 0); w > 0 {
		q.Set("window", strconv.Itoa(w))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/issues", q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("issues", "", status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	var reply struct {
		WindowMinutes int                      `json:"window_minutes"`
		GeneratedAt   string                   `json:"generated_at"`
		Issues        []map[string]interface{} `json:"issues"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("issues: unreadable reply: %w", err)
	}
	scope := scopedNamespaces(ctx)
	inScope := func(ns string) bool {
		if namespace != "" {
			return ns == namespace
		}
		if len(scope) == 0 {
			return true
		}
		for _, s := range scope {
			if s == ns {
				return true
			}
		}
		return false
	}
	counts := map[string]int{"critical": 0, "warning": 0, "info": 0}
	kept := make([]map[string]interface{}, 0, len(reply.Issues))
	for _, issue := range reply.Issues {
		ns, _ := issue["namespace"].(string)
		sev, _ := issue["severity"].(string)
		if !inScope(ns) || (severity != "" && sev != severity) {
			continue
		}
		counts[sev]++
		kept = append(kept, issue)
	}
	total := len(kept)
	truncated := false
	if len(kept) > issuesCap {
		kept = kept[:issuesCap]
		truncated = true
	}
	result := map[string]interface{}{
		"window_minutes": reply.WindowMinutes,
		"generated_at":   reply.GeneratedAt,
		"namespace":      namespaceOrAll(namespace),
		"counts":         counts,
		"total":          total,
		"issues":         kept,
	}
	if len(scope) > 0 && namespace == "" {
		result["namespace"] = scope
	}
	if truncated {
		result["truncated"] = true
	}
	if total == 0 {
		result["hint"] = "Nothing is failing in the checked scope right now (pods, workloads, nodes, PVCs, Warning events in the window)."
	}
	return marshalJSON(result)
}
