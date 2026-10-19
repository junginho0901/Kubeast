// The cluster's alerts in its alert store (Alertmanager, or Grafana alerting's
// Alertmanager-compatible API) and the silences on them — through k8s-service,
// which asks the store with the cluster label and checks every alert again.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const (
	alertsCap         = 50
	alertsAlternative = "No alert store is configured for this cluster. Use prometheus_rules for the alerts the cluster's Prometheus rules fire; say silences are not visible here."
)

// handleAlertsList lists the cluster's alerts (firing first, then by severity)
// with counts by state and name, and the silences on the silenced ones.
func handleAlertsList(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	state := strings.TrimSpace(argString(args, "state", ""))
	if state == "" {
		state = "firing"
	}
	q.Set("state", state)
	if name := strings.TrimSpace(argString(args, "alertname", "")); name != "" {
		q.Set("alertname", name)
	}
	labels := argStringMap(args, "alert_labels")
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		q.Add("label", k+"="+labels[k])
	}
	status, body, err := k8sServiceGet(ctx, headers, "/alertstore/alerts", q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("alertStore", alertsAlternative, status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	var reply struct {
		Alerts    []map[string]interface{} `json:"alerts"`
		Total     int                      `json:"total"`
		States    map[string]int           `json:"states"`
		ByName    []interface{}            `json:"byName"`
		Silences  []interface{}            `json:"silences"`
		Truncated bool                     `json:"truncated"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("alert store: unreadable reply: %w", err)
	}
	alerts, truncated := reply.Alerts, reply.Truncated
	if len(alerts) > alertsCap {
		alerts, truncated = alerts[:alertsCap], true
	}
	result := map[string]interface{}{
		"state": state, "total": reply.Total, "returned": len(alerts), "states": reply.States,
		"by_name": reply.ByName, "alerts": alerts, "silences": reply.Silences,
	}
	switch {
	case reply.Total == 0 && state != "all":
		result["hint"] = fmt.Sprintf("No %s alert for this cluster. The counts in states are every state: ask state=all (or silenced) to see the others.", state)
	case reply.Total == 0:
		result["hint"] = "The alert store holds no alert for this cluster. An alert that never came may have no rule (prometheus_rules) or be routed to another Alertmanager."
	}
	if truncated {
		result["truncated"] = true
		result["note"] = fmt.Sprintf("The first %d of %d (firing first, then by severity); by_name counts them all. Narrow with alertname or alert_labels.", len(alerts), reply.Total)
	}
	return marshalJSON(result)
}
