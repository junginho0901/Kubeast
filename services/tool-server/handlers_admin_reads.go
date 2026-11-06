// Admin reads of what spans Kubeast: Access review, AI Usage, Access requests and the audit log's integrity line, from
// the same auth-service routes as the user, and a cluster's hygiene sign-offs from k8s-service. Those routes ask their
// own permission and write their own audit rows. Each answer names the fields it gives, so what a route adds later
// does not reach a model by itself. Nothing here changes anything: signing off, verifying the chain, approving and
// rejecting stay on the screens.

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
	adminPageDefault = 25 // the screens' page
	// The sign-offs k8s-service answers at most (handler hygieneHistoryMax).
	hygieneHistoryCap = 100

	reviewAlternative         = "Access review is off on this installation (auth.accessReview.enabled). Use audit_search for who changed what."
	usageAlternative          = "AI Usage adds up the audit rows ai.chat.complete and ai.investigation.run; audit_search reads those rows."
	accessRequestsAlternative = "Use the Access requests screen (Admin → Access requests)."
	integrityAlternative      = "Use the Audit Logs screen (Admin → Audit Logs)."
	hygieneHistoryAlternative = "The cluster hygiene report is off (features.hygiene.enabled), so nothing is signed off here."
)

// pickFields copies the named fields a row has, an empty one too: null says "not recorded" as it does on the screen.
func pickFields(row map[string]interface{}, fields ...string) map[string]interface{} {
	out := make(map[string]interface{}, len(fields))
	for _, field := range fields {
		if v, ok := row[field]; ok {
			out[field] = v
		}
	}
	return out
}

func pickRows(rows []interface{}, fields []string) []interface{} {
	out := make([]interface{}, 0, len(rows))
	for _, r := range rows {
		if row, ok := r.(map[string]interface{}); ok {
			out = append(out, pickFields(row, fields...))
		}
	}
	return out
}

// signOffRows are the rows of past sign-offs: their counts are numbers, whatever else a stored row holds.
func signOffRows(rows []interface{}, fields []string) []interface{} {
	out := pickRows(rows, fields)
	for _, r := range out {
		row := r.(map[string]interface{})
		row["counts"] = countsOf(row["counts"])
	}
	return out
}

func countsOf(v interface{}) map[string]interface{} {
	counts, _ := v.(map[string]interface{})
	out := make(map[string]interface{}, len(counts))
	for name, n := range counts {
		if _, isNumber := n.(float64); isNumber {
			out[name] = n
		}
	}
	return out
}

func adminPage(args map[string]interface{}) (limit, offset int) {
	limit = argInt(args, "limit", adminPageDefault)
	if limit < 1 || limit > rowsCap {
		limit = rowsCap
	}
	offset = argInt(args, "offset", 0)
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func pageOfRows(rows []interface{}, limit, offset int) []interface{} {
	if offset >= len(rows) {
		return []interface{}{}
	}
	end := offset + limit
	if end > len(rows) {
		end = len(rows)
	}
	return rows[offset:end]
}

// placeOf says where a page stands in its list: total counts every match, as the screens' pagers do.
func placeOf(out map[string]interface{}, total, returned, offset int) {
	out["total"] = total
	out["returned"] = returned
	out["offset"] = offset
	if next := offset + returned; returned > 0 && next < total {
		out["next_offset"] = next
	}
}

// marshalRows puts the rows last: a model reads a long answer cut at its tool result length, and where it stands comes first.
func marshalRows(out map[string]interface{}) (string, error) {
	return marshalOrdered(out, nil, []string{"rows"})
}

// listReply decodes a 200 that is a JSON list; anything else goes through featureFailure.
func listReply(feature, alternative string, status int, body []byte) ([]interface{}, string, error) {
	if status != http.StatusOK {
		out, ok, err := featureFailure(feature, alternative, status, body)
		if ok {
			return nil, out, nil
		}
		return nil, "", err
	}
	var rows []interface{}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, "", fmt.Errorf("%s: unreadable reply: %w", feature, err)
	}
	return rows, "", nil
}

// totalOf reads the count of every match beside a page. An answer without it is an error, as on the screens: not a count of the rows that came.
func totalOf(feature string, headers http.Header) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(headers.Get("X-Kubeast-Total")))
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s: the answer has no X-Kubeast-Total count", feature)
	}
	return n, nil
}

// sinceQuery reads since_time into the RFC3339 value these routes take.
func sinceQuery(args map[string]interface{}, q url.Values) error {
	v := argString(args, "since_time", "")
	if v == "" {
		return nil
	}
	t, err := parseFromTime(v, time.Now())
	if err != nil {
		return wrapBadRequest("since_time: " + err.Error())
	}
	q.Set("since", t.UTC().Format(time.RFC3339))
	return nil
}

// A section of the access review report: the fields of a row, and the columns the screen's search box reads, in the
// screen's order ("" is a column it does not read).
type reviewSection struct {
	fields, searched []string
}

var reviewSections = map[string]reviewSection{
	"users": {
		[]string{"email", "name", "team", "auth_source", "global_role", "created_at", "last_login_at", "locked_until", "dormant_locked_at", "cluster_roles", "api_keys", "temporary_grants", "flags"},
		[]string{"email", "name", "team", "global_role", "", "", "", "", "flags"},
	},
	"cluster_roles": {
		[]string{"user_email", "cluster", "role", "namespaces", "granted_via", "expires_at", "restore_role", "flags"},
		[]string{"user_email", "cluster", "role", "namespaces", "granted_via", "", "", "flags"},
	},
	"api_keys": {
		[]string{"owner_email", "name", "key_prefix", "clusters", "role_ceiling", "created_at", "expires_at", "last_used_at", "last_used_ip", "flags"},
		[]string{"owner_email", "name", "key_prefix", "clusters", "", "", "", "", "flags"},
	},
	"access_requests": {
		[]string{"requester_email", "cluster", "role", "duration_minutes", "reason", "status", "created_at", "decided_by_email", "decided_at", "decision_note", "expires_at", "ended_at", "end_reason"},
		[]string{"requester_email", "cluster", "role", "", "reason", "status", "", "decided_by_email"},
	},
	"roles": {
		[]string{"name", "is_system", "description", "permissions", "users", "cluster_bindings", "flags"},
		[]string{"name", "description", "permissions", "", "flags"},
	},
}

var reviewSummaryFields = []string{"users", "global_admins", "full_admins", "dormant", "never_logged_in", "locked", "dormant_locked", "cluster_grants", "temporary_grants", "api_keys_active", "api_keys_expiring", "api_keys_unused", "access_requests"}

// reviewRowText is what the search box compares: the columns' text joined with spaces, lower case.
func reviewRowText(row map[string]interface{}, searched []string) string {
	cells := make([]string, len(searched))
	for i, field := range searched {
		switch v := row[field].(type) {
		case string:
			cells[i] = v
		case []interface{}:
			words := make([]string, 0, len(v))
			for _, word := range v {
				words = append(words, fmt.Sprint(word))
			}
			cells[i] = strings.Join(words, " ")
		}
	}
	return strings.ToLower(strings.Join(cells, " "))
}

func rowHasFlag(row map[string]interface{}, flag string) bool {
	flags, _ := row["flags"].([]interface{})
	for _, f := range flags {
		if f == flag {
			return true
		}
	}
	return false
}

// handleAccessReview reads Admin → Access review: the cards, one section's rows, the past sign-offs or the report a
// sign-off stored.
func handleAccessReview(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	section := argString(args, "review_section", "summary")
	if section == "history" {
		return accessReviewHistory(ctx, args, headers)
	}
	report, signedOff, out, err := readAccessReview(ctx, args, headers)
	if err != nil || out != "" {
		return out, err
	}
	answer := pickFields(report, "generated_at", "since", "next_due_at", "overdue")
	answer["section"] = section
	if signedOff != nil {
		answer["signed_off"] = signedOff
	}
	if section == "summary" {
		return accessReviewSummary(answer, report)
	}
	def, known := reviewSections[section]
	if !known {
		return "", wrapBadRequest("review_section: " + section + " is not a section of the report")
	}
	all, _ := report[section].([]interface{})
	search := strings.TrimSpace(argString(args, "search", ""))
	needle := strings.ToLower(search)
	matching := make([]interface{}, 0, len(all))
	for _, r := range all {
		row, ok := r.(map[string]interface{})
		if ok && (needle == "" || strings.Contains(reviewRowText(row, def.searched), needle)) {
			matching = append(matching, r)
		}
	}
	limit, offset := adminPage(args)
	rows := pickRows(pageOfRows(matching, limit, offset), def.fields)
	answer["rows"] = rows
	placeOf(answer, len(matching), len(rows), offset)
	if search != "" {
		answer["search"] = search
	}
	switch section {
	case "cluster_roles":
		if summary, ok := report["summary"].(map[string]interface{}); ok {
			if n, has := summary["full_admins"]; has {
				answer["full_admins"] = n
			}
		}
		answer["note"] = `These are per-cluster grants. An account whose global role carries "*" reaches every cluster without a row here: full_admins counts them, and review_section=users gives each account's global role.`
	case "api_keys":
		expired := 0
		for _, r := range all {
			if row, ok := r.(map[string]interface{}); ok && rowHasFlag(row, "expired") {
				expired++
			}
		}
		answer["expired"] = expired
	case "access_requests":
		if total, ok := report["access_requests_total"].(float64); ok && int(total) > len(all) {
			answer["requests_cut"] = map[string]interface{}{"shown": len(all), "total": int(total), "since": report["since"]}
		}
	}
	return marshalRows(answer)
}

// readAccessReview gets the live report, or the one a sign-off stored with who signed. out is set when the route refused.
func readAccessReview(ctx context.Context, args map[string]interface{}, headers http.Header) (report, signedOff map[string]interface{}, out string, err error) {
	reviewID := argString(args, "review_id", "")
	if reviewID == "" {
		q := url.Values{}
		if err := sinceQuery(args, q); err != nil {
			return nil, nil, "", err
		}
		status, body, err := authServiceGet(ctx, headers, "/admin/access-review", q)
		if err != nil {
			return nil, nil, "", err
		}
		report, out, err = featureReply("access_review", reviewAlternative, status, body)
		return report, nil, out, err
	}
	status, body, err := authServiceGet(ctx, headers, "/admin/access-review/history/"+url.PathEscape(reviewID), nil)
	if err != nil {
		return nil, nil, "", err
	}
	if detail := detailOf(body); status == http.StatusNotFound && !featureMissing(detail) {
		out, err = marshalJSON(map[string]interface{}{"status": "not_found", "feature": "access_review", "reason": detail, "hint": "review_section=history lists the sign-offs and their ids."})
		return nil, nil, out, err
	}
	reply, out, err := featureReply("access_review", reviewAlternative, status, body)
	if err != nil || out != "" {
		return nil, nil, out, err
	}
	report, ok := reply["snapshot"].(map[string]interface{})
	if !ok {
		return nil, nil, "", fmt.Errorf("access_review: sign-off %s has no stored report", reviewID)
	}
	return report, pickFields(reply, "id", "reviewed_by_email", "reviewed_at", "note"), "", nil
}

func accessReviewSummary(answer, report map[string]interface{}) (string, error) {
	if settings, ok := report["settings"].(map[string]interface{}); ok {
		answer["settings"] = pickFields(settings, "dormant_days", "interval_days", "lock_enabled", "lock_days", "lock_exempt_admins")
	}
	answer["last_review"] = nil
	if last, ok := report["last_review"].(map[string]interface{}); ok {
		answer["last_review"] = pickFields(last, "id", "reviewed_by_email", "reviewed_at", "note")
	}
	if summary, ok := report["summary"].(map[string]interface{}); ok {
		answer["summary"] = pickFields(summary, reviewSummaryFields...)
	}
	sections := map[string]interface{}{}
	for name := range reviewSections {
		rows, _ := report[name].([]interface{})
		sections[name] = len(rows)
	}
	keys, _ := report["api_keys"].([]interface{})
	expired := 0
	for _, r := range keys {
		if row, ok := r.(map[string]interface{}); ok && rowHasFlag(row, "expired") {
			expired++
		}
	}
	sections["api_keys_expired"] = expired
	if total, has := report["access_requests_total"]; has {
		sections["access_requests_total"] = total
	}
	answer["sections"] = sections
	answer["hint"] = "review_section=users, cluster_roles, api_keys, access_requests or roles lists that tab's rows; review_section=history the past sign-offs; review_id opens one as it stood."
	return marshalJSON(answer)
}

func accessReviewHistory(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	limit, offset := adminPage(args)
	q := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	status, body, answerHeaders, err := authServiceRead(ctx, headers, "/admin/access-review/history", q)
	if err != nil {
		return "", err
	}
	rows, out, err := listReply("access_review", reviewAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	total, err := totalOf("access_review", answerHeaders)
	if err != nil {
		return "", err
	}
	answer := map[string]interface{}{"section": "history", "rows": signOffRows(rows, []string{"id", "reviewed_by_email", "reviewed_at", "note", "counts"})}
	placeOf(answer, total, len(rows), offset)
	if total == 0 {
		answer["hint"] = "No review has been signed off yet."
	}
	return marshalRows(answer)
}

var (
	usageRowFields   = []string{"source", "key", "requests", "failures", "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "prompt_chars", "token_requests", "tool_calls", "avg_duration_ms", "last_at"}
	usageTotalFields = []string{"groups", "rows", "requests", "failures", "prompt_tokens", "completion_tokens", "total_tokens", "token_requests", "tool_calls", "truncated"}
)

// handleAIUsage reads Admin → AI Usage. The route lists every group of the period at once and the screen pages them, so
// the page is cut here; the totals and the cut are the server's, never the listed rows added up.
func handleAIUsage(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{"group": {argString(args, "usage_group", "user")}}
	if err := sinceQuery(args, q); err != nil {
		return "", err
	}
	if v := argString(args, "until_time", ""); v != "" {
		q.Set("until", v)
	}
	status, body, err := authServiceGet(ctx, headers, "/admin/ai-usage", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("ai_usage", usageAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	all, _ := reply["rows"].([]interface{})
	limit, offset := adminPage(args)
	rows := pickRows(pageOfRows(all, limit, offset), usageRowFields)
	answer := pickFields(reply, "since", "until", "group", "truncated")
	answer["listed_limit"] = reply["limit"]
	answer["rows"] = rows
	placeOf(answer, len(all), len(rows), offset)

	sourceTotals, _ := reply["totals"].(map[string]interface{})
	totals := map[string]interface{}{}
	var cuts []interface{}
	for _, source := range []string{"chat", "investigation", "all"} {
		t, ok := sourceTotals[source].(map[string]interface{})
		if !ok {
			continue
		}
		totals[source] = pickFields(t, usageTotalFields...)
		if source != "all" && t["truncated"] == true {
			cuts = append(cuts, map[string]interface{}{"source": source, "shown": t["rows"], "groups": t["groups"]})
		}
	}
	answer["totals"] = totals
	if len(cuts) > 0 {
		answer["cuts"] = cuts
	}
	for _, r := range all {
		row, _ := r.(map[string]interface{})
		requests, _ := row["requests"].(float64)
		counted, _ := row["token_requests"].(float64)
		if counted < requests {
			answer["partial_tokens"] = "Some requests have no token count (the provider sent none, or an alert investigation failed before the end); the row total leaves them out."
			break
		}
	}
	return marshalRows(answer)
}

var (
	accessRequestStatuses = map[string]bool{"pending": true, "approved": true, "rejected": true, "cancelled": true, "expired": true, "decided": true}
	accessRequestFields   = []string{"id", "user_email", "user_name", "cluster_id", "cluster_name", "role", "duration_minutes", "reason", "status", "created_at", "decided_by_email", "decided_at", "decision_note", "expires_at", "ended_at", "end_reason", "namespaces"}
)

// handleAccessRequests reads Admin → Access requests: a tab's page from the route that pages and counts it. Deciding
// a request stays on the screen.
func handleAccessRequests(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	state := argString(args, "status", "pending")
	if !accessRequestStatuses[state] {
		return "", wrapBadRequest("status: " + state + " is not one of pending, decided, approved, rejected, cancelled, expired")
	}
	limit, offset := adminPage(args)
	q := url.Values{"status": {state}, "limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	search := strings.TrimSpace(argString(args, "search", ""))
	if search != "" {
		q.Set("q", search)
	}
	status, body, answerHeaders, err := authServiceRead(ctx, headers, "/admin/access-requests", q)
	if err != nil {
		return "", err
	}
	rows, out, err := listReply("access_requests", accessRequestsAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	total, err := totalOf("access_requests", answerHeaders)
	if err != nil {
		return "", err
	}
	answer := map[string]interface{}{"status": state, "rows": pickRows(rows, accessRequestFields)}
	placeOf(answer, total, len(rows), offset)
	if search != "" {
		answer["search"] = search
	}
	// The screen says when the feature is off; what was filed before is still listed.
	if code, config, err := authServiceGet(ctx, headers, "/access-requests/config", nil); err == nil && code == http.StatusOK {
		var feature struct {
			Enabled bool `json:"enabled"`
		}
		if json.Unmarshal(config, &feature) == nil {
			answer["enabled"] = feature.Enabled
			if !feature.Enabled {
				answer["note"] = "Access requests are off on this installation (auth.accessRequests.enabled)."
			}
		}
	}
	return marshalRows(answer)
}

// handleAuditIntegrity reads the integrity line of Admin → Audit Logs: how far the hash chain is sealed and its last
// anchor. Verifying the chain recomputes it and is its own audited action on that screen.
func handleAuditIntegrity(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	status, body, err := authServiceGet(ctx, headers, "/admin/audit/integrity", nil)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("audit_integrity", integrityAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	if enabled, _ := reply["enabled"].(bool); !enabled {
		return marshalJSON(map[string]interface{}{"enabled": false, "note": "Audit log integrity is off on this installation (audit.integrity.enabled), so the rows are not chained."})
	}
	answer := pickFields(reply, "enabled", "seal_seconds", "anchor_sink", "anchor_hours", "oldest_seq", "sealed_through_seq", "unsealed_rows")
	answer["last_anchor"] = nil
	if anchor, ok := reply["last_anchor"].(map[string]interface{}); ok {
		answer["last_anchor"] = pickFields(anchor, "id", "created_at", "from_seq", "to_seq", "rows", "anchor_hash", "sink", "object_key", "actor")
	}
	answer["note"] = "This says how far the chain is sealed and when it was last anchored; it does not check the chain. The Verify button on Admin → Audit Logs checks it."
	return marshalJSON(answer)
}

// handleHygieneHistory reads the Past sign-offs tab of Admin → Cluster hygiene for this cluster, or the report one stored.
func handleHygieneHistory(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if reviewID := argString(args, "review_id", ""); reviewID != "" {
		return hygieneSignedOff(ctx, reviewID, args, headers)
	}
	q := url.Values{}
	if limit := argInt(args, "limit", 0); limit > 0 && limit < hygieneHistoryCap {
		q.Set("limit", strconv.Itoa(limit))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/hygiene/history", q)
	if err != nil {
		return "", err
	}
	rows, out, err := listReply("hygiene_history", hygieneHistoryAlternative, status, body)
	if err != nil {
		return "", err
	}
	if out != "" {
		return hygieneOffAnswer(ctx, out, headers)
	}
	answer := map[string]interface{}{
		"cluster":  clusterIDFromCtx(ctx),
		"returned": len(rows),
		"rows":     signOffRows(rows, []string{"id", "cluster", "reviewed_by_email", "reviewed_at", "note", "counts"}),
	}
	addHygieneSettings(ctx, answer, headers)
	if len(rows) >= hygieneHistoryCap {
		answer["truncated"] = true
		answer["note"] = fmt.Sprintf("The newest %d sign-offs of this cluster are listed.", hygieneHistoryCap)
	}
	if len(rows) == 0 {
		answer["hint"] = "This cluster has not been signed off yet."
	}
	return marshalRows(answer)
}

// addHygieneSettings adds whether the report is on and how often a sign-off is due; settings it could not read are not zeroes.
func addHygieneSettings(ctx context.Context, answer map[string]interface{}, headers http.Header) {
	var settings struct {
		Enabled      bool `json:"enabled"`
		IntervalDays int  `json:"interval_days"`
	}
	status, body, err := k8sServiceGet(ctx, headers, "/hygiene/config", nil)
	if err == nil && status != http.StatusOK {
		err = fmt.Errorf("status %d: %s", status, detailOf(body))
	}
	if err == nil {
		err = json.Unmarshal(body, &settings)
	}
	if err != nil {
		answer["interval_days"] = nil
		answer["settings_error"] = err.Error()
		return
	}
	answer["enabled"], answer["interval_days"] = settings.Enabled, settings.IntervalDays
}

// hygieneOffAnswer adds the settings to the answer of a report that is off, and leaves any other refusal as it is.
func hygieneOffAnswer(ctx context.Context, refusal string, headers http.Header) (string, error) {
	var answer map[string]interface{}
	if err := json.Unmarshal([]byte(refusal), &answer); err != nil || answer["status"] != "unavailable" {
		return refusal, nil
	}
	addHygieneSettings(ctx, answer, headers)
	return marshalJSON(answer)
}

func hygieneSignedOff(ctx context.Context, reviewID string, args map[string]interface{}, headers http.Header) (string, error) {
	status, body, err := k8sServiceGet(ctx, headers, "/hygiene/snapshot/"+url.PathEscape(reviewID), nil)
	if err != nil {
		return "", err
	}
	if detail := detailOf(body); status == http.StatusNotFound && !featureMissing(detail) {
		return marshalJSON(map[string]interface{}{"status": "not_found", "feature": "hygiene_history", "reason": detail, "hint": "hygiene_history without review_id lists this cluster's sign-offs and their ids."})
	}
	reply, out, err := featureReply("hygiene_history", hygieneHistoryAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	signedOff := pickFields(reply, "id", "cluster", "reviewed_by_email", "reviewed_at", "note")
	signedOff["counts"] = countsOf(reply["counts"])
	answer := map[string]interface{}{"cluster": clusterIDFromCtx(ctx), "signed_off": signedOff}
	if snapshot, ok := reply["snapshot"].(map[string]interface{}); ok {
		if report, ok := snapshot["report"].(map[string]interface{}); ok {
			cutHygieneReport(report, args)
			answer["report"] = report
		}
	}
	return marshalOrdered(answer, []string{"cluster", "signed_off"}, []string{"report"})
}
