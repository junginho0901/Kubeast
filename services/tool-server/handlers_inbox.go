// clusters_list is the cluster picker's list (auth-service GET /api/v1/clusters) and alert_investigate the alert
// window's "Investigate now" (ai-service POST /api/v1/alerts/inbox/{id}/investigate). Both call the screen's route with
// the caller's own token, so its permission checks, audit rows, queue and limits are the screen's; this side finds the
// alert, keeps to the fields a screen shows and shapes the answer.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

var (
	aiServiceURL = envOrDefault("AI_SERVICE_URL", "http://ai-service:8001")
	// The console's address, which the investigation's own audit row links with; empty = a path on the console.
	consoleURL = strings.TrimRight(strings.TrimSpace(os.Getenv("ALERT_INVESTIGATION_CONSOLE_URL")), "/")
)

const (
	inboxPageSize          = 200
	inboxPagesMax          = 5
	inboxCandidatesCap     = 20
	permInvestigationsRead = "admin.investigations.read"

	inboxAlternative  = "Investigations are off on this installation (features.alertInvestigation). Read the alert with alerts_list and prometheus_rules and look into it with the read tools."
	inboxNotFoundHint = "Only what Alertmanager sent to Kubeast's webhook is in the Alerts inbox; alerts_list reads the alert store, which can hold more. Say the alert is not in the inbox instead of guessing another name."
)

// The picker's fields, for anyone holding a grant on the cluster.
var clusterRowFields = []string{"id", "display_name", "mode", "is_self_cluster", "health_status", "last_healthcheck_at"}

// What Admin → Clusters adds for a holder of admin.clusters.list. A row reaches the model only through these two lists.
var clusterAdminFields = []string{
	"api_server_url", "created_by", "prometheus_url", "prometheus_cluster_label", "prometheus_auth", "prometheus_service",
	"log_search_url", "log_search_tenant", "log_search_cluster_label", "log_search_auth",
}

// The alert's fields in the answer: what the alert window opens with.
var inboxAlertFields = []string{"id", "cluster", "alertname", "severity", "namespace", "status", "summary", "starts_at", "resolved_at", "labels"}

// A row of several that matched: enough to tell them apart, and the id to call with.
var inboxCandidateFields = []string{"id", "alertname", "severity", "namespace", "status", "summary", "starts_at", "labels", "investigation"}

func pick(from map[string]interface{}, fields []string) map[string]interface{} {
	out := make(map[string]interface{}, len(fields))
	for _, field := range fields {
		out[field] = from[field]
	}
	return out
}

func clusterRows(ctx context.Context, headers http.Header, q url.Values) ([]map[string]interface{}, string, error) {
	status, body, err := authServiceGetAt(ctx, headers, "/api/v1/clusters", q)
	if err != nil {
		return nil, "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("clusters", "Use get_cluster_overview for the current cluster.", status, body)
		if ok {
			return nil, out, nil
		}
		return nil, "", ferr
	}
	var reply struct {
		Items []map[string]interface{} `json:"items"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		return nil, "", fmt.Errorf("clusters: unreadable reply: %w", err)
	}
	return reply.Items, "", nil
}

// handleClustersList answers what the picker lists for the caller; a holder of admin.clusters.list also gets what
// Admin → Clusters lists, with which of them the caller reaches.
func handleClustersList(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	payload, _ := auth.FromContext(ctx)
	picker, out, err := clusterRows(ctx, headers, url.Values{"accessibleOnly": {"true"}})
	if err != nil || out != "" {
		return out, err
	}
	rows := picker
	registry := payload.HasPermission(auth.PermClustersList)
	reached := map[string]bool{}
	if registry {
		for _, row := range picker {
			reached[fmt.Sprint(row["id"])] = true
		}
		if rows, out, err = clusterRows(ctx, headers, nil); err != nil || out != "" {
			return out, err
		}
	}
	current := clusterIDFromCtx(ctx)
	clusters := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		id := fmt.Sprint(row["id"])
		one := pick(row, clusterRowFields)
		one["current"] = id == current
		if namespaces := payload.Namespaces[id]; len(namespaces) > 0 {
			one["namespaces"] = namespaces
		}
		if registry {
			one["reachable"] = reached[id]
			for _, field := range clusterAdminFields {
				if value, ok := row[field]; ok {
					one[field] = value
				}
			}
		}
		clusters = append(clusters, one)
	}
	return marshalJSON(map[string]interface{}{
		"total":    len(clusters),
		"clusters": clusters,
		"note":     "health_status is the last connection check, at last_healthcheck_at: k8s-service probes each cluster every 60 seconds unless multicluster.healthcheckIntervalSec changes or stops it (healthy, disconnected), and a person's Test in Admin → Clusters also writes it (unreachable when it fails); unknown = never checked.",
	})
}

func aiServiceDo(ctx context.Context, headers http.Header, method, path string, q url.Values) (int, []byte, error) {
	target := aiServiceURL + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return 0, nil, err
	}
	if authorization := headers.Get("Authorization"); authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	// The route's audit row keeps it: this press came from a tool, not the window.
	req.Header.Set("User-Agent", "kubeast-tool-server")
	resp, err := featureHTTP.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("ai-service %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, featureBodyCap))
	if err != nil {
		return 0, nil, fmt.Errorf("ai-service %s: %w", path, err)
	}
	return resp.StatusCode, body, nil
}

func inboxItemPath(id string) string {
	return "/api/v1/alerts/inbox/" + url.PathEscape(id)
}

// inboxFailure turns a refusal of the inbox routes into a result the model can say: a refused press keeps the code, the
// words and the numbers the alert window shows; a spent budget or a pause is a wait, not too many calls.
func inboxFailure(status int, body []byte) (string, error) {
	var reply struct {
		Detail json.RawMessage `json:"detail"`
	}
	_ = json.Unmarshal(body, &reply)
	var refusal struct {
		Code    string      `json:"code"`
		Message string      `json:"message"`
		Until   interface{} `json:"until"`
		Budget  interface{} `json:"budget"`
		Used    interface{} `json:"used"`
	}
	if json.Unmarshal(reply.Detail, &refusal) != nil || refusal.Code == "" {
		refusal.Message = detailOf(body)
	}
	switch {
	case status == http.StatusNotFound && featureMissing(refusal.Message):
		return unavailableResult("alertInvestigation", refusal.Message, inboxAlternative)
	case status == http.StatusNotFound:
		return marshalJSON(map[string]interface{}{"status": "not_found", "feature": "alertInbox", "reason": refusal.Message, "hint": inboxNotFoundHint})
	case status == http.StatusServiceUnavailable:
		return marshalJSON(map[string]interface{}{"status": "audit_unavailable", "reason": refusal.Message,
			"hint": "Nothing was started or read: the audit log cannot take the record right now. Tell the user."})
	case status == http.StatusBadRequest:
		return "", wrapBadRequest(refusal.Message)
	case status != http.StatusForbidden && status != http.StatusTooManyRequests:
		return "", fmt.Errorf("ai-service alert inbox: status %d: %s", status, refusal.Message)
	}
	result := map[string]interface{}{"status": "forbidden", "feature": "alertInvestigation", "reason": refusal.Message,
		"hint": "Your grant or this installation does not allow it. Tell the user what was refused instead of trying another way."}
	if status == http.StatusTooManyRequests {
		result["status"] = "rate_limited"
		result["hint"] = "No investigation starts until the time in until (UTC). Tell the user, with that time, and do not call again before it."
	}
	if refusal.Code != "" {
		result["code"], result["until"], result["budget"], result["used"] = refusal.Code, refusal.Until, refusal.Budget, refusal.Used
	}
	return marshalJSON(result)
}

func labelsHold(row map[string]interface{}, want map[string]string) bool {
	labels, _ := row["labels"].(map[string]interface{})
	for key, value := range want {
		if fmt.Sprint(labels[key]) != value {
			return false
		}
	}
	return true
}

// inboxAlertNamed finds the one inbox row the arguments name in this cluster, or answers why not. The screen's search
// matches parts of many fields, so the name, the namespace and the labels are compared here. Open rows come first: an
// alert that fired again has older, resolved rows of its name.
func inboxAlertNamed(ctx context.Context, args map[string]interface{}, headers http.Header) (string, string, error) {
	name := argString(args, "alertname", "")
	namespace := argString(args, "namespace", "")
	labels := argStringMap(args, "alert_labels")
	q := url.Values{"cluster": {clusterIDFromCtx(ctx)}, "q": {name}, "limit": {strconv.Itoa(inboxPageSize)}}
	var open, closed []map[string]interface{}
	offset, cut := 0, true
	for page := 0; page < inboxPagesMax && cut; page++ {
		q.Set("offset", strconv.Itoa(offset))
		status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/alerts/inbox", q)
		if err != nil {
			return "", "", err
		}
		if status != http.StatusOK {
			out, err := inboxFailure(status, body)
			return "", out, err
		}
		var reply struct {
			Items []map[string]interface{} `json:"items"`
			Total int                      `json:"total"`
		}
		if err := json.Unmarshal(body, &reply); err != nil {
			return "", "", fmt.Errorf("alert inbox: unreadable reply: %w", err)
		}
		for _, row := range reply.Items {
			if fmt.Sprint(row["alertname"]) != name || (namespace != "" && fmt.Sprint(row["namespace"]) != namespace) || !labelsHold(row, labels) {
				continue
			}
			if row["status"] == "resolved" {
				closed = append(closed, row)
			} else {
				open = append(open, row)
			}
		}
		offset += len(reply.Items)
		cut = len(reply.Items) > 0 && offset < reply.Total
	}
	found := open
	if len(found) == 0 {
		found = closed
	}
	switch len(found) {
	case 0:
		out, err := marshalJSON(map[string]interface{}{"status": "not_found", "feature": "alertInbox", "alertname": name, "truncated": cut, "hint": inboxNotFoundHint})
		return "", out, err
	case 1:
		return fmt.Sprint(found[0]["id"]), "", nil
	}
	candidates := make([]map[string]interface{}, 0, inboxCandidatesCap)
	for _, row := range found {
		if len(candidates) == inboxCandidatesCap {
			break
		}
		candidates = append(candidates, pick(row, inboxCandidateFields))
	}
	out, err := marshalJSON(map[string]interface{}{"status": "ambiguous", "total": len(found), "alerts": candidates, "truncated": cut || len(found) > len(candidates),
		"hint": "Several alerts match, so nothing was started. Ask the user which one, or call again with its alert_id."})
	return "", out, err
}

func inboxWindowOf(ctx context.Context, headers http.Header, id string) (map[string]interface{}, string, error) {
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, inboxItemPath(id), nil)
	if err != nil {
		return nil, "", err
	}
	if status != http.StatusOK {
		out, err := inboxFailure(status, body)
		return nil, out, err
	}
	var window map[string]interface{}
	if err := json.Unmarshal(body, &window); err != nil {
		return nil, "", fmt.Errorf("alert inbox: unreadable reply: %w", err)
	}
	// The call is pinned to the chat's cluster, as every tool call is; another cluster's alert is not this one's to press.
	if fmt.Sprint(window["cluster"]) != clusterIDFromCtx(ctx) {
		out, err := marshalJSON(map[string]interface{}{"status": "not_found", "feature": "alertInbox", "reason": "alert not found in this cluster", "hint": inboxNotFoundHint})
		return nil, out, err
	}
	return window, "", nil
}

// investigationAnswer leads with what the chat needs, for a result cut at the model's limit.
type investigationAnswer struct {
	Started        bool                   `json:"started"`
	Note           string                 `json:"note"`
	Investigation  interface{}            `json:"investigation"`
	ReportLink     string                 `json:"report_link,omitempty"`
	AlertLink      string                 `json:"alert_link"`
	InvestigateNow interface{}            `json:"investigate_now"`
	Error          interface{}            `json:"error,omitempty"`
	ReportError    string                 `json:"report_error,omitempty"`
	Model          interface{}            `json:"model,omitempty"`
	TotalTokens    interface{}            `json:"total_tokens,omitempty"`
	ToolCallCount  interface{}            `json:"tool_call_count,omitempty"`
	DurationMS     interface{}            `json:"duration_ms,omitempty"`
	FinishedAt     interface{}            `json:"finished_at,omitempty"`
	Report         string                 `json:"report,omitempty"`
	ReportChars    *int                   `json:"report_chars,omitempty"`
	Alert          map[string]interface{} `json:"alert"`
}

const (
	noteStarted  = "Queued: it runs in the background as kubeast:investigator and stores its report at report_link. Say so and give the link. The summary comes from a later call with status_only=true."
	noteBusy     = "This firing's investigation is already %s, so nothing new was started. Give report_link. The summary comes from a later call with status_only=true."
	noteDone     = "The report of this firing's investigation; nothing new was started. Summarize report and give report_link."
	noteEnded    = "The last investigation ended %s (see error or investigation.skip_reason) and nothing new was started. A call without status_only starts a new one, which costs tokens: only if the user asks."
	noteNotAsked = "This alert has no investigation yet and none was started. A call without status_only starts one, which costs tokens: only if the user asks."
)

func noteFor(started bool, status string) string {
	switch {
	case started:
		return noteStarted
	case status == "done":
		return noteDone
	case status == "queued" || status == "running":
		return fmt.Sprintf(noteBusy, status)
	case status == "":
		return noteNotAsked
	}
	return fmt.Sprintf(noteEnded, status)
}

// addReport reads the report through the route that records its view (ai.investigation.view). A report that cannot be
// read leaves the rest of the answer standing, with why.
func addReport(ctx context.Context, headers http.Header, id string, answer *investigationAnswer) error {
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, inboxItemPath(id)+"/investigation", nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		answer.ReportError = detailOf(body)
		return nil
	}
	var detail map[string]interface{}
	if err := json.Unmarshal(body, &detail); err != nil {
		return fmt.Errorf("investigation: unreadable reply: %w", err)
	}
	if text := fmt.Sprint(detail["error"]); detail["error"] != nil && text != "" {
		answer.Error = text
	}
	answer.Model, answer.TotalTokens, answer.ToolCallCount, answer.DurationMS, answer.FinishedAt =
		detail["model"], detail["total_tokens"], detail["tool_call_count"], detail["duration_ms"], detail["finished_at"]
	if report, _ := detail["report"].(string); report != "" {
		chars := len([]rune(report))
		answer.Report, answer.ReportChars = report, &chars
	}
	return nil
}

// handleAlertInvestigate presses "Investigate now" on one alert of the Alerts inbox, or with status_only reads how its
// investigation went. A press on a firing already queued, running or done starts nothing, as on the screen.
func handleAlertInvestigate(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	id := argString(args, "alert_id", "")
	if id == "" {
		if argString(args, "alertname", "") == "" {
			return "", wrapBadRequest("alert_investigate needs alert_id or alertname")
		}
		found, out, err := inboxAlertNamed(ctx, args, headers)
		if err != nil || out != "" {
			return out, err
		}
		id = found
	}
	window, out, err := inboxWindowOf(ctx, headers, id)
	if err != nil || out != "" {
		return out, err
	}
	if !argBool(args, "status_only") {
		status, body, err := aiServiceDo(ctx, headers, http.MethodPost, inboxItemPath(id)+"/investigate", nil)
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			return inboxFailure(status, body)
		}
		window = nil
		if err := json.Unmarshal(body, &window); err != nil {
			return "", fmt.Errorf("alert inbox: unreadable reply: %w", err)
		}
	}
	started, _ := window["started"].(bool)
	investigation, _ := window["investigation"].(map[string]interface{})
	investigationStatus, investigationID := "", ""
	if investigation != nil {
		investigationStatus, investigationID = fmt.Sprint(investigation["status"]), fmt.Sprint(investigation["id"])
	}
	alertLink := consoleURL + "/alerts?" + url.Values{"alert": {id}, "cluster": {clusterIDFromCtx(ctx)}}.Encode()
	answer := investigationAnswer{
		Started: started, Note: noteFor(started, investigationStatus), Investigation: window["investigation"],
		AlertLink: alertLink, InvestigateNow: window["investigate_now"], Alert: pick(window, inboxAlertFields),
	}
	if investigation != nil {
		answer.ReportLink = alertLink
		if payload, ok := auth.FromContext(ctx); ok && payload.HasPermission(permInvestigationsRead) {
			answer.ReportLink = consoleURL + "/admin/investigations?id=" + url.QueryEscape(investigationID)
		}
	}
	if investigationStatus == "done" || investigationStatus == "failed" {
		if err := addReport(ctx, headers, id, &answer); err != nil {
			return "", err
		}
	}
	return marshalJSON(answer)
}
