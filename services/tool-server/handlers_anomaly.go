// The narrowing as a tool: k8s-service compares a namespace's window with the window of the same length before it and
// ranks what differs (internal/anomaly), as the caller. The answer is kept near anomalyRankChars, half the model's default
// result limit, so it leaves room for the reads it points to: examples go first, then the last findings, each cut said.

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const anomalyRankChars = 3000

var (
	anomalyFirstKeys = []string{"namespace", "workload", "window", "compared_with", "findings_total", "findings_note", "examples_note", "call_order", "not_run", "normal", "store_queries"}
	anomalyLastKeys  = []string{"findings"}
)

// handleAnomalyRank answers what differs in one namespace (or one workload's pods) between since_time–until_time
// (default the last hour) and the window before it.
func handleAnomalyRank(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := strings.TrimSpace(argString(args, "namespace", ""))
	if namespace == "" {
		return "", wrapBadRequest("namespace is required")
	}
	q := url.Values{}
	// k8s-service ends a window it is not given at the minute, so a relative start counts back from there too
	end := time.Now().Truncate(time.Minute)
	if until := argString(args, "until_time", ""); until != "" {
		t, err := time.Parse(time.RFC3339, until)
		if err != nil {
			return "", wrapBadRequest("until_time must be an RFC3339 time")
		}
		q.Set("end", t.UTC().Format(time.RFC3339))
		if t.Before(end) {
			end = t
		}
	}
	if since := argString(args, "since_time", ""); since != "" {
		t, err := parseFromTime(since, end)
		if err != nil {
			return "", wrapBadRequest("since_time: " + err.Error())
		}
		q.Set("start", t.UTC().Format(time.RFC3339))
	}
	kind, name := argString(args, "workload_kind", ""), argString(args, "workload_name", "")
	if (kind == "") != (name == "") {
		return "", wrapBadRequest("workload_kind and workload_name go together")
	}
	if kind != "" {
		q.Set("workload_kind", kind)
		q.Set("workload_name", name)
	}
	askSince(q)
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/anomalies", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("anomaly_rank", "issues", status, body)
	if err != nil || out != "" {
		return out, err
	}
	return fitAnomalies(reply)
}

// fitAnomalies writes the answer within anomalyRankChars: the examples of the last findings go first, then the last
// findings, and the answer says what was cut. One finding always stays.
func fitAnomalies(reply map[string]interface{}) (string, error) {
	out, err := marshalOrdered(reply, anomalyFirstKeys, anomalyLastKeys)
	if err != nil || len(out) <= anomalyRankChars {
		return out, err
	}
	findings, _ := reply["findings"].([]interface{})
	for i := len(findings) - 1; i >= 0 && len(out) > anomalyRankChars; i-- {
		f, _ := findings[i].(map[string]interface{})
		if _, ok := f["examples"]; !ok {
			continue
		}
		delete(f, "examples")
		reply["examples_note"] = "Examples were left out of the last findings to keep the answer short; read those objects for them."
		if out, err = marshalOrdered(reply, anomalyFirstKeys, anomalyLastKeys); err != nil {
			return "", err
		}
	}
	listed := len(findings)
	for len(out) > anomalyRankChars && listed > 1 {
		listed--
		reply["findings"] = findings[:listed]
		reply["findings_note"] = fmt.Sprintf("The first %d of the %d findings are listed, the rest cut to keep the answer short; narrow with workload_kind and workload_name or a shorter window.",
			listed, len(findings))
		if out, err = marshalOrdered(reply, anomalyFirstKeys, anomalyLastKeys); err != nil {
			return "", err
		}
	}
	return out, nil
}
