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
	silencesCap       = 200
	alertsAlternative = "No alert store is configured for this cluster. Use prometheus_rules for the alerts the cluster's Prometheus rules fire; say silences are not visible here."
)

// handleSilencesList answers the Alerts page's Silences tab, whose silences may match no alert now, with its counts by scope.
func handleSilencesList(ctx context.Context, headers http.Header) (string, error) {
	status, body, err := k8sServiceGet(ctx, headers, "/alertstore/silences", nil)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("alertStore", alertsAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	silences, _ := reply["silences"].([]interface{})
	own := 0
	for _, s := range silences {
		row, _ := s.(map[string]interface{})
		// As the tab reads a silence that names no scope.
		if scope, _ := row["scope"].(string); scope == "" || scope == "cluster" {
			own++
		}
	}
	result := map[string]interface{}{"total": len(silences), "this_cluster": own, "other_scopes": len(silences) - own}
	if len(silences) == 0 {
		silences = []interface{}{}
		result["hint"] = "No silence is active or pending on this cluster's alerts."
	}
	if len(silences) > silencesCap {
		result["truncated"] = true
		result["note"] = fmt.Sprintf("The first %d of %d, those ending soonest; the counts cover them all.", silencesCap, len(silences))
		silences = silences[:silencesCap]
	}
	result["returned"], result["silences"] = len(silences), silences
	return marshalOrdered(result, nil, []string{"silences"})
}

// handleAlertsList lists the cluster's alerts (firing first, then by severity)
// with counts by state and name, and the silences on the silenced ones.
func handleAlertsList(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if argBool(args, "silences") {
		return handleSilencesList(ctx, headers)
	}
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
		result["hint"] = fmt.Sprintf("No %s alert in the alert store for this cluster. The counts in states are every state: ask state=all (or silenced) to see the others. "+
			"Prometheus may still fire alerts that never reach this store: check prometheus_rules with active_only=true before saying nothing fires.", state)
	case reply.Total == 0:
		result["hint"] = "The alert store holds no alert for this cluster. Prometheus may still fire alerts that are not routed here: check prometheus_rules with active_only=true before saying nothing fires; an alert that never came may have no rule."
	}
	if truncated {
		result["truncated"] = true
		result["note"] = fmt.Sprintf("The first %d of %d (firing first, then by severity); by_name counts them all. Narrow with alertname or alert_labels.", len(alerts), reply.Total)
	}
	return marshalJSON(result)
}
