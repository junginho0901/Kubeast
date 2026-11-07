// Admin reads of Kubeast's own records: Investigations and AI Models from ai-service, Session recordings from
// k8s-service, each from the route its screen reads, with the user's own token, so the route's permission check and
// audit rows stand. An answer names the fields it gives: what a terminal showed, a model's key and its address never
// reach it, and the routes that would give the first are not called.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
)

const (
	investigationsNotFoundHint = "investigations without investigation_id lists the reports and their ids."
	recordingsNotFoundHint     = "session_recordings without recording_id lists the recordings and their ids."
	recordingsOutputNote       = "These are a recording's details. What the terminal showed opens on the Session recordings screen (Admin → Session recordings), where each view is audited; no tool reads it."
	recordingsOffNote          = "Session recording is off on this installation (sessionRecording.enabled). Earlier recordings stay listed."
	aiModelsNote               = "A limit that is null is the call's default: 4096 tokens for a chat answer, 2048 for an investigation step, 6000 characters of a tool result. key_env_set false is the card's No key env warning, and null a provider that asks for no key. Keys, the variables' names, addresses and other settings stay on the AI Models screen."
)

// A report as the Investigations list shows it; the screen's catalog key and values of skip_reason are its own wording.
var investigationRowFields = []string{
	"id", "cluster", "alertname", "severity", "namespace", "status", "skip_reason", "received_at", "started_at", "finished_at",
	"repeat_count", "last_seen_at", "requested_by", "model", "total_tokens", "iterations", "tool_call_count", "duration_ms",
}

// What the report window adds. The report comes after what says what it is about, for a result cut at the model's limit.
var (
	investigationDetailFields   = []string{"fingerprint", "starts_at", "generator_url", "alertmanager_url", "provider", "prompt_tokens", "completion_tokens", "error", "report", "labels", "annotations"}
	investigationToolCallFields = []string{"tool", "args", "step", "result_chars", "error", "access"}
	investigationAnswerLast     = []string{"report", "tool_calls", "labels", "annotations"}
)

// A recording's details. user_id stays out: the screen names the person by mail address.
var recordingFields = []string{
	"id", "kind", "user_email", "cluster", "namespace", "target", "container", "storage", "started_at", "ended_at",
	"bytes", "uploaded_bytes", "parts", "status", "truncated", "last_error",
}

// A model as the cards name it. Its limits are read from options by name, and nothing else in options is.
var aiModelFields = []string{"id", "name", "provider", "model", "enabled", "is_default", "tier", "used_for"}

// The ranges of app/services/ai/limits.py: a stored value outside them runs as the call's default.
var aiModelLimits = map[string][2]float64{"max_tokens": {1, 1_000_000}, "tool_result_chars": {1_000, 200_000}}

// The providers whose card asks for no key (frontend modelCatalog.ts needsApiKey false).
var keylessProviders = map[string]bool{"ollama": true}

// aiServiceRefusal turns a refusal of an ai-service read into a result the model can say; anything else is an error naming that service.
func aiServiceRefusal(feature, notFoundHint string, status int, body []byte) (string, error) {
	detail := detailOf(body)
	switch status {
	case http.StatusServiceUnavailable:
		return marshalJSON(map[string]interface{}{"status": "audit_unavailable", "feature": feature, "reason": detail,
			"hint": "Nothing was read: the audit log cannot take the record right now. Tell the user."})
	case http.StatusNotFound:
		return marshalJSON(map[string]interface{}{"status": "not_found", "feature": feature, "reason": detail, "hint": notFoundHint})
	case http.StatusForbidden, http.StatusTooManyRequests, http.StatusBadRequest:
		out, ok, err := featureFailure(feature, "", status, body)
		if ok {
			return out, nil
		}
		return "", err
	}
	return "", fmt.Errorf("ai-service %s: status %d: %s", feature, status, detail)
}

// marshalInvestigationReport is one report as its window opens: for investigations and for an alert window's report alike.
func marshalInvestigationReport(detail map[string]interface{}) (string, error) {
	out := pickFields(detail, investigationRowFields...)
	for field, value := range pickFields(detail, investigationDetailFields...) {
		out[field] = value
	}
	calls, _ := detail["tool_calls"].([]interface{})
	out["tool_calls"] = pickRows(calls, investigationToolCallFields)
	return marshalOrdered(out, investigationRowFields, investigationAnswerLast)
}

// handleInvestigations reads Admin → Investigations: a page of the list, or one report through the route that records its view.
func handleInvestigations(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if id := argString(args, "investigation_id", ""); id != "" {
		status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/ai/investigations/"+url.PathEscape(id), nil)
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			return aiServiceRefusal("investigations", investigationsNotFoundHint, status, body)
		}
		var detail map[string]interface{}
		if err := json.Unmarshal(body, &detail); err != nil {
			return "", fmt.Errorf("investigations: unreadable reply: %w", err)
		}
		return marshalInvestigationReport(detail)
	}
	limit, offset := adminPage(args)
	q := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	answer := map[string]interface{}{}
	if value := argString(args, "status", ""); value != "" {
		q.Set("status", value)
		answer["status_filter"] = value
	}
	// The route's cluster is a filter, and the screen lists every cluster's reports until one is asked for.
	if value := argString(args, "cluster_id", ""); value != "" {
		q.Set("cluster", value)
		answer["cluster_filter"] = value
	}
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/ai/investigations", q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return aiServiceRefusal("investigations", investigationsNotFoundHint, status, body)
	}
	var reply struct {
		Items []interface{} `json:"items"`
		Total int           `json:"total"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("investigations: unreadable reply: %w", err)
	}
	answer["rows"] = pickRows(reply.Items, investigationRowFields)
	placeOf(answer, reply.Total, len(reply.Items), offset)
	if reply.Total == 0 {
		answer["hint"] = "No report matches. Reports are written for alerts while features.alertInvestigation is on; alerts_inbox lists the alerts."
	}
	return marshalRows(answer)
}

// modelLimit is a limit as the model runs with it: a stored value outside its range is empty there too.
func modelLimit(options map[string]interface{}, name string) interface{} {
	value, ok := options[name].(float64)
	bounds := aiModelLimits[name]
	if !ok || value != math.Trunc(value) || value < bounds[0] || value > bounds[1] {
		return nil
	}
	return value
}

// keyEnvSet reads as the AI Models card draws it: true beside a named variable, false where it warns "No key env", null where
// its provider asks for no key. The variable's name stays out of the answer.
func keyEnvSet(config map[string]interface{}) interface{} {
	if name, _ := config["api_key_env"].(string); name != "" {
		return true
	}
	if provider, _ := config["provider"].(string); keylessProviders[provider] {
		return nil
	}
	return false
}

// handleAIModels reads Admin → AI Models: each model's name, provider, what it runs, whether a key variable is set and its limits.
func handleAIModels(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/ai/model-configs", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return aiServiceRefusal("ai_models", "", status, body)
	}
	var configs []map[string]interface{}
	if err := json.Unmarshal(body, &configs); err != nil {
		return "", fmt.Errorf("ai_models: unreadable reply: %w", err)
	}
	rows := make([]map[string]interface{}, 0, len(configs))
	var active interface{}
	for _, config := range configs {
		row := pickFields(config, aiModelFields...)
		row["key_env_set"] = keyEnvSet(config)
		options, _ := config["options"].(map[string]interface{})
		for name := range aiModelLimits {
			row[name] = modelLimit(options, name)
		}
		// The card's Active badge reads this.
		used, _ := config["used_for"].([]interface{})
		for _, use := range used {
			if use == "chat" {
				active = config["name"]
			}
		}
		rows = append(rows, row)
	}
	answer := map[string]interface{}{"total": len(rows), "active": active, "note": aiModelsNote, "rows": rows}
	addProviderAvailability(ctx, answer, headers)
	return marshalOrdered(answer, []string{"total", "active"}, []string{"rows"})
}

// addProviderAvailability says which providers this install cannot run; not read is not "all available".
func addProviderAvailability(ctx context.Context, answer map[string]interface{}, headers http.Header) {
	var reply struct {
		Providers map[string]map[string]interface{} `json:"providers"`
	}
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/ai/model-configs/providers", nil)
	if err == nil && status != http.StatusOK {
		err = fmt.Errorf("status %d: %s", status, detailOf(body))
	}
	if err == nil {
		err = json.Unmarshal(body, &reply)
	}
	if err != nil {
		answer["providers_error"] = err.Error()
		return
	}
	providers := make(map[string]interface{}, len(reply.Providers))
	for name, provider := range reply.Providers {
		providers[name] = pickFields(provider, "available", "reason")
	}
	answer["providers"] = providers
}

// handleSessionRecordings reads Admin → Session recordings: who opened which terminal, when, how much was kept. The
// route of what the terminal showed, which writes admin.session.read, is the screen's alone.
func handleSessionRecordings(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if id := argString(args, "recording_id", ""); id != "" {
		status, _, body, err := k8sServiceRead(ctx, headers, "/recordings/"+url.PathEscape(id), url.Values{})
		if err != nil {
			return "", err
		}
		if detail := detailOf(body); status == http.StatusNotFound && !featureMissing(detail) {
			return marshalJSON(map[string]interface{}{"status": "not_found", "feature": "session_recordings", "reason": detail, "hint": recordingsNotFoundHint})
		}
		reply, out, err := featureReply("session_recordings", "", status, body)
		if err != nil || out != "" {
			return out, err
		}
		return marshalOrdered(map[string]interface{}{"note": recordingsOutputNote, "recording": pickFields(reply, recordingFields...)}, []string{"note"}, nil)
	}
	limit, offset := adminPage(args)
	// The route counts nothing: one row past the page says there is more, as on the screen.
	q := url.Values{"limit": {strconv.Itoa(limit + 1)}}
	if offset > 0 {
		q.Set("offset", strconv.Itoa(offset))
	}
	for name, arg := range map[string]string{"user": "actor_email", "kind": "recording_kind", "cluster": "cluster_id"} {
		if value := argString(args, arg, ""); value != "" {
			q.Set(name, value)
		}
	}
	status, _, body, err := k8sServiceRead(ctx, headers, "/recordings", q)
	if err != nil {
		return "", err
	}
	rows, out, err := listReply("session_recordings", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	answer := map[string]interface{}{"offset": offset, "note": recordingsOutputNote}
	if len(rows) > limit {
		rows = rows[:limit]
		answer["next_offset"] = offset + limit
	}
	answer["returned"] = len(rows)
	answer["rows"] = pickRows(rows, recordingFields)
	if len(rows) == 0 {
		answer["hint"] = "No recording matches. Pod exec and node shell terminals are recorded while sessionRecording.enabled is on."
	}
	addRecordingSwitch(ctx, answer, headers)
	return marshalRows(answer)
}

// addRecordingSwitch adds whether terminals are recorded now; not read is not off.
func addRecordingSwitch(ctx context.Context, answer map[string]interface{}, headers http.Header) {
	var config struct {
		Enabled bool `json:"enabled"`
	}
	status, _, body, err := k8sServiceRead(ctx, headers, "/recordings/config", url.Values{})
	if err == nil && status != http.StatusOK {
		err = fmt.Errorf("status %d: %s", status, detailOf(body))
	}
	if err == nil {
		err = json.Unmarshal(body, &config)
	}
	if err != nil {
		answer["enabled"] = nil
		answer["settings_error"] = err.Error()
		return
	}
	answer["enabled"] = config.Enabled
	if !config.Enabled {
		answer["note"] = recordingsOffNote + " " + recordingsOutputNote
	}
}
