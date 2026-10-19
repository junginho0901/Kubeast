// Finding what the cluster's Prometheus holds before querying it: metric
// names, labels, rules and scrape targets, through k8s-service like
// prometheus_query (same source, same cluster scoping, the caller's token).

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	promNamesDefault   = 50
	promNamesCap       = 200
	promValuesCap      = 200
	promRulesCap       = 100
	promRuleAlertsCap  = 10
	promTargetsCap     = 200
	promAnnotationCap  = 300
	rulesAlternative   = "This metrics store does not serve rules (for VictoriaMetrics the query side needs -vmalert.proxyURL). If the store records alert state, prometheus_query on ALERTS{alertstate=\"firing\"} shows what fires; otherwise say the rules are not available here."
	targetsUpHintShort = "Health comes from the up series (1 = the last scrape worked); this store has no targets API or is shared by several clusters."
)

// promFeatureGet calls one k8s-service Prometheus path and decodes the reply,
// or returns the result the model gets when Prometheus is missing or refuses.
func promFeatureGet(ctx context.Context, headers http.Header, path string, q url.Values, alternative string, into interface{}) (string, bool, error) {
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", false, err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("prometheus", alternative, status, body)
		if ok {
			return out, true, nil
		}
		return "", true, ferr
	}
	var avail struct {
		Available bool `json:"available"`
	}
	if err := json.Unmarshal(body, &avail); err != nil {
		return "", true, fmt.Errorf("prometheus: unreadable reply: %w", err)
	}
	if !avail.Available {
		out, err := unavailableResult("prometheus", "no Prometheus is reachable for this cluster", promAlternative)
		return out, true, err
	}
	if err := json.Unmarshal(body, into); err != nil {
		return "", true, fmt.Errorf("prometheus: unreadable reply: %w", err)
	}
	return "", false, nil
}

// handlePrometheusMetrics finds metric names (part of the name, case-insensitive)
// with their type and help text.
func handlePrometheusMetrics(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	limit := argInt(args, "limit", promNamesDefault)
	if limit <= 0 || limit > promNamesCap {
		limit = min(max(limit, promNamesDefault), promNamesCap)
	}
	q := url.Values{"limit": {strconv.Itoa(limit)}}
	pattern := strings.TrimSpace(argString(args, "pattern", ""))
	if pattern != "" {
		q.Set("pattern", pattern)
	}
	var reply struct {
		Metrics   []map[string]interface{} `json:"metrics"`
		Total     int                      `json:"total"`
		Truncated bool                     `json:"truncated"`
	}
	if out, done, err := promFeatureGet(ctx, headers, "/prometheus/metrics", q, promAlternative, &reply); done {
		return out, err
	}
	result := map[string]interface{}{"pattern": pattern, "total": reply.Total, "metrics": reply.Metrics}
	switch {
	case reply.Total == 0:
		result["hint"] = "No metric name contains that text in the last hour. Try a shorter part (cpu, memory, http, restarts) or no pattern; the exporter that produces it may not run here."
	case reply.Truncated:
		result["truncated"] = true
		result["hint"] = fmt.Sprintf("Only %d of %d names are listed. Narrow the pattern before choosing one.", len(reply.Metrics), reply.Total)
	}
	return marshalJSON(result)
}

// handlePrometheusLabels lists label names on the series a selector matches,
// or the values of one label.
func handlePrometheusLabels(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	label := strings.TrimSpace(argString(args, "label", ""))
	selector := strings.TrimSpace(argString(args, "selector", ""))
	for k, v := range map[string]string{"label": label, "selector": selector, "since": argString(args, "since", "")} {
		if v != "" {
			q.Set(k, v)
		}
	}
	limit := argInt(args, "limit", promValuesCap)
	if limit <= 0 || limit > promValuesCap {
		limit = promValuesCap
	}
	q.Set("limit", strconv.Itoa(limit))
	var reply struct {
		Names     []string `json:"names"`
		Values    []string `json:"values"`
		Truncated bool     `json:"truncated"`
		Since     string   `json:"since"`
	}
	if out, done, err := promFeatureGet(ctx, headers, "/prometheus/labels", q, promAlternative, &reply); done {
		return out, err
	}
	result := map[string]interface{}{"selector": selector, "since": reply.Since}
	found := len(reply.Names)
	if label != "" {
		result["label"] = label
		result["values"] = reply.Values
		found = len(reply.Values)
	} else {
		result["names"] = reply.Names
	}
	switch {
	case found == 0:
		result["hint"] = "Nothing matched. Check the selector's metric name with prometheus_metrics, or widen since."
	case reply.Truncated:
		result["truncated"] = true
		result["hint"] = "The list is cut. Add a matcher to the selector to narrow it before relying on it."
	}
	return marshalJSON(result)
}

// handlePrometheusRules lists alerting and recording rules with their state
// and active alerts.
func handlePrometheusRules(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	if t := argString(args, "rule_type", ""); t != "" {
		q.Set("type", t)
	}
	if r := strings.TrimSpace(argString(args, "rule", "")); r != "" {
		q.Set("rule", r)
	}
	var reply struct {
		Rules  []map[string]interface{} `json:"rules"`
		Shared bool                     `json:"shared"`
	}
	if out, done, err := promFeatureGet(ctx, headers, "/prometheus/rules", q, rulesAlternative, &reply); done {
		return out, err
	}
	activeOnly := argBool(args, "active_only")
	rules := make([]map[string]interface{}, 0, len(reply.Rules))
	counts := map[string]int{}
	for _, r := range reply.Rules {
		state, _ := r["state"].(string)
		if state != "" {
			counts[state]++
		}
		if activeOnly && state != "firing" && state != "pending" {
			continue
		}
		if ann, ok := r["annotations"].(map[string]interface{}); ok {
			for k, v := range ann {
				if s, ok := v.(string); ok && len(s) > promAnnotationCap {
					ann[k] = s[:promAnnotationCap] + "…"
				}
			}
		}
		if alerts, ok := r["alerts"].([]interface{}); ok && len(alerts) > promRuleAlertsCap {
			r["alerts_total"] = len(alerts)
			r["alerts"] = alerts[:promRuleAlertsCap]
		}
		rules = append(rules, r)
	}
	result := map[string]interface{}{"rules_total": len(reply.Rules), "states": counts}
	if len(rules) > promRulesCap {
		rules = rules[:promRulesCap]
		result["truncated"] = true
		result["hint"] = "More rules than shown. Filter by rule (part of the name), rule_type or active_only."
	}
	result["rules"] = rules
	if reply.Shared {
		result["scope"] = "shared store: the rules may be written for every cluster; their alerts and states here are this cluster's only"
	}
	if len(reply.Rules) == 0 {
		result["hint"] = "No rule matched. Without a filter this store has no rules."
	}
	return marshalJSON(result)
}

// handlePrometheusTargets reports scrape targets and their health, the down
// ones first.
func handlePrometheusTargets(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	var reply struct {
		Targets []map[string]interface{} `json:"targets"`
		Source  string                   `json:"source"`
	}
	if out, done, err := promFeatureGet(ctx, headers, "/prometheus/targets", nil, promAlternative, &reply); done {
		return out, err
	}
	health := argString(args, "health", "")
	job := strings.ToLower(strings.TrimSpace(argString(args, "job", "")))
	counts := map[string]int{}
	var down, rest []map[string]interface{}
	for _, t := range reply.Targets {
		h, _ := t["health"].(string)
		counts[h]++
		if health != "" && h != health {
			continue
		}
		if j, _ := t["job"].(string); job != "" && !strings.Contains(strings.ToLower(j), job) {
			continue
		}
		if h == "up" {
			rest = append(rest, t)
		} else {
			down = append(down, t)
		}
	}
	targets := append(down, rest...)
	result := map[string]interface{}{"source": reply.Source, "health": counts, "total": len(reply.Targets)}
	if len(targets) > promTargetsCap {
		targets = targets[:promTargetsCap]
		result["truncated"] = true
	}
	result["targets"] = targets
	if reply.Source == "up_metric" {
		result["note"] = targetsUpHintShort
	}
	return marshalJSON(result)
}
