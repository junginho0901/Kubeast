package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

const fakeCredential = "fake-credential-value"

// What a route's answer might hold beside the fields a screen shows: no answer may carry any of it.
const credentialFields = `"password_hash":"` + fakeCredential + `","hashed_password":"` + fakeCredential + `","key_hash":"` + fakeCredential + `","key":"` + fakeCredential + `","token":"` + fakeCredential + `","refresh_token":"` + fakeCredential + `","api_key":"` + fakeCredential + `"`

type authReply struct {
	status      int
	body, total string
}

// fakeAuthReplies answers auth-service's paths; a path without a reply fails the test.
func fakeAuthReplies(t *testing.T, replies map[string]authReply) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		reply, ok := replies[r.URL.Path]
		if !ok {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if reply.total != "" {
			w.Header().Set("X-Kubeast-Total", reply.total)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.status)
		_, _ = w.Write([]byte(reply.body))
	}))
	orig := authServiceURL
	authServiceURL = srv.URL
	t.Cleanup(func() { authServiceURL = orig; srv.Close() })
	return &seen
}

// withCredentials adds the fields no answer may carry to a JSON object.
func withCredentials(row string) string {
	return strings.TrimSuffix(row, "}") + "," + credentialFields + "}"
}

func listWithCredentials(rows ...string) string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, withCredentials(row))
	}
	return "[" + strings.Join(out, ",") + "]"
}

func parsed(t *testing.T, s string) interface{} {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("%v in %s", err, s)
	}
	return v
}

// An answer without the field reads as empty, so the check names the value instead of stopping the run.
func textOf(v interface{}) string {
	s, _ := v.(string)
	return s
}

func mapOf(v interface{}) map[string]interface{} {
	m, _ := v.(map[string]interface{})
	return m
}

func listOf(v interface{}) []interface{} {
	l, _ := v.([]interface{})
	return l
}

func firstRow(m map[string]interface{}) map[string]interface{} {
	if rows := listOf(m["rows"]); len(rows) > 0 {
		return mapOf(rows[0])
	}
	return nil
}

func assertSame(t *testing.T, what string, got interface{}, want string) {
	t.Helper()
	if w := parsed(t, want); !reflect.DeepEqual(got, w) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(w)
		t.Errorf("%s:\n got %s\nwant %s", what, gotJSON, wantJSON)
	}
}

func assertNoCredentials(t *testing.T, what, out string) {
	t.Helper()
	for _, name := range []string{fakeCredential, "password_hash", "hashed_password", "key_hash", "refresh_token"} {
		if strings.Contains(out, name) {
			t.Errorf("%s carries %s: %s", what, name, out)
		}
	}
}

const (
	reviewUserAnn = `{"email":"ann@example.com","name":"Ann Kim","team":"sre","auth_source":"oidc","global_role":"Admin","created_at":"2026-01-01T00:00:00Z","last_login_at":"2026-11-01T00:00:00Z","cluster_roles":0,"api_keys":1,"temporary_grants":0,"flags":["global_admin"]}`
	reviewUserBob = `{"email":"bob@example.com","name":"Bob","team":"","auth_source":"local","global_role":"Member","created_at":"2026-01-02T00:00:00Z","last_login_at":null,"cluster_roles":2,"api_keys":1,"temporary_grants":1,"flags":["never_logged_in","dormant"]}`
	reviewUserCho = `{"email":"cho@example.com","name":"Cho","team":"dev","auth_source":"local","global_role":"Member","created_at":"2026-01-03T00:00:00Z","last_login_at":"2026-10-01T00:00:00Z","locked_until":"2026-12-01T00:00:00Z","dormant_locked_at":"2026-10-02T00:00:00Z","cluster_roles":1,"api_keys":0,"temporary_grants":0,"flags":["locked"]}`

	reviewGrantProd  = `{"user_email":"bob@example.com","cluster":"prod-seoul","role":"Write","namespaces":["shop","pay"],"granted_via":"permanent","flags":[]}`
	reviewGrantAlpha = `{"user_email":"bob@example.com","cluster":"alpha","role":"Write","granted_via":"request:rq1","expires_at":"2026-11-08T00:00:00Z","restore_role":"Read","flags":["temporary"]}`
	reviewGrantCho   = `{"user_email":"cho@example.com","cluster":"prod-seoul","role":"Read","granted_via":"permanent","flags":[]}`

	reviewKeyCI  = `{"owner_email":"ann@example.com","name":"ci","key_prefix":"kbk_abcd1234","clusters":["self"],"role_ceiling":"Read","created_at":"2026-01-01T00:00:00Z","expires_at":"2026-02-01T00:00:00Z","last_used_at":null,"flags":["expired"]}`
	reviewKeyBot = `{"owner_email":"bob@example.com","name":"bot","key_prefix":"kbk_efgh5678","clusters":[],"role_ceiling":"Write","created_at":"2026-01-01T00:00:00Z","expires_at":"2027-02-01T00:00:00Z","last_used_at":"2026-11-01T00:00:00Z","last_used_ip":"10.0.0.9","flags":[]}`

	reviewRequestNew = `{"requester_email":"bob@example.com","cluster":"alpha","role":"Write","duration_minutes":60,"reason":"deploy fix","status":"approved","created_at":"2026-11-01T00:00:00Z","decided_by_email":"ann@example.com","decided_at":"2026-11-01T01:00:00Z","decision_note":"fine","expires_at":"2026-11-08T00:00:00Z"}`
	reviewRequestOld = `{"requester_email":"cho@example.com","cluster":"prod-seoul","role":"Write","duration_minutes":30,"reason":"look at logs","status":"expired","created_at":"2026-10-01T00:00:00Z","ended_at":"2026-10-02T00:00:00Z","end_reason":"expired"}`

	reviewRoleAdmin  = `{"name":"Admin","is_system":true,"description":"everything","permissions":["*"],"users":1,"cluster_bindings":0,"flags":["has_admin_permissions"]}`
	reviewRoleCustom = `{"name":"auditor","is_system":false,"description":"reads the log","permissions":["admin.audit.read"],"users":0,"cluster_bindings":0,"flags":["has_admin_permissions","unused"]}`

	reviewSummary = `{"users":3,"global_admins":1,"full_admins":1,"dormant":1,"never_logged_in":1,"locked":1,"dormant_locked":1,"cluster_grants":3,"temporary_grants":1,"api_keys_active":1,"api_keys_expiring":0,"api_keys_unused":0,"access_requests":2}`
	reviewLast    = `{"id":"r1","reviewed_by_email":"boss@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"signed"}`
	reviewSetting = `{"dormant_days":90,"interval_days":90,"lock_enabled":true,"lock_days":180,"lock_exempt_admins":false}`
)

func reviewReport() string {
	return withCredentials(`{"generated_at":"2026-11-07T01:00:00Z","settings":` + withCredentials(reviewSetting) + `,"since":"2026-08-01T00:00:00Z","last_review":` + withCredentials(reviewLast) +
		`,"next_due_at":"2026-10-30T00:00:00Z","overdue":true,"summary":` + withCredentials(reviewSummary) +
		`,"users":` + listWithCredentials(reviewUserAnn, reviewUserBob, reviewUserCho) +
		`,"cluster_roles":` + listWithCredentials(reviewGrantProd, reviewGrantAlpha, reviewGrantCho) +
		`,"api_keys":` + listWithCredentials(reviewKeyCI, reviewKeyBot) +
		`,"access_requests":` + listWithCredentials(reviewRequestNew, reviewRequestOld) + `,"access_requests_total":7` +
		`,"roles":` + listWithCredentials(reviewRoleAdmin, reviewRoleCustom) + `}`)
}

func accessReviewAnswer(t *testing.T, a map[string]interface{}) (map[string]interface{}, string) {
	t.Helper()
	out, err := handleAccessReview(ctxFor("c1"), a, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "access_review", out)
	return decode(t, out), out
}

func TestAccessReview_TheSummaryIsWhatTheCardsAndTabsShow(t *testing.T) {
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, reviewReport(), ""}})
	m, _ := accessReviewAnswer(t, map[string]interface{}{})
	req := (*seen)[0]
	if req.Method != http.MethodGet || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", req.Method, req.Header.Get("Authorization"))
	}
	// Kubeast-wide: its audit row carries no cluster, so no cluster goes with the request.
	if req.URL.Query().Has("cluster") {
		t.Fatalf("a Kubeast-wide read names a cluster: %s", req.URL.RawQuery)
	}
	assertSame(t, "summary", m["summary"], reviewSummary)
	assertSame(t, "settings", m["settings"], reviewSetting)
	assertSame(t, "last_review", m["last_review"], reviewLast)
	if m["section"] != "summary" || m["generated_at"] != "2026-11-07T01:00:00Z" || m["since"] != "2026-08-01T00:00:00Z" || m["next_due_at"] != "2026-10-30T00:00:00Z" || m["overdue"] != true {
		t.Errorf("head: %v", m)
	}
	assertSame(t, "sections", m["sections"], `{"users":3,"cluster_roles":3,"api_keys":2,"api_keys_expired":1,"access_requests":2,"access_requests_total":7,"roles":2}`)
	if _, has := m["rows"]; has {
		t.Errorf("the summary lists rows: %v", m["rows"])
	}
}

func TestAccessReview_SectionsPageWithTheScreensRowsAndCounts(t *testing.T) {
	report := reviewReport()
	replies := map[string]authReply{"/api/v1/auth/admin/access-review": {200, report, ""}}
	fakeAuthReplies(t, replies)

	for section, rows := range map[string]string{
		"users":           "[" + reviewUserAnn + "," + reviewUserBob + "," + reviewUserCho + "]",
		"cluster_roles":   "[" + reviewGrantProd + "," + reviewGrantAlpha + "," + reviewGrantCho + "]",
		"api_keys":        "[" + reviewKeyCI + "," + reviewKeyBot + "]",
		"access_requests": "[" + reviewRequestNew + "," + reviewRequestOld + "]",
		"roles":           "[" + reviewRoleAdmin + "," + reviewRoleCustom + "]",
	} {
		m, _ := accessReviewAnswer(t, map[string]interface{}{"review_section": section})
		assertSame(t, section, m["rows"], rows)
		n := len(parsed(t, rows).([]interface{}))
		if m["section"] != section || m["total"] != float64(n) || m["returned"] != float64(n) || m["offset"] != float64(0) || m["next_offset"] != nil {
			t.Errorf("%s place: %v %v %v %v", section, m["total"], m["returned"], m["offset"], m["next_offset"])
		}
	}

	// One page, and where the next starts.
	m, _ := accessReviewAnswer(t, map[string]interface{}{"review_section": "cluster_roles", "limit": 2})
	assertSame(t, "first page", m["rows"], "["+reviewGrantProd+","+reviewGrantAlpha+"]")
	if m["total"] != float64(3) || m["returned"] != float64(2) || m["next_offset"] != float64(2) {
		t.Errorf("first page place: %v %v %v", m["total"], m["returned"], m["next_offset"])
	}
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "cluster_roles", "limit": 2, "offset": 2})
	assertSame(t, "last page", m["rows"], "["+reviewGrantCho+"]")
	if m["total"] != float64(3) || m["returned"] != float64(1) || m["offset"] != float64(2) || m["next_offset"] != nil {
		t.Errorf("last page place: %v %v %v %v", m["total"], m["returned"], m["offset"], m["next_offset"])
	}
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "cluster_roles", "offset": 9})
	assertSame(t, "past the end", m["rows"], "[]")
	if m["total"] != float64(3) || m["returned"] != float64(0) {
		t.Errorf("past the end place: %v %v", m["total"], m["returned"])
	}

	// A global admin has no grant row: the answer says so, with the count the card shows.
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "cluster_roles"})
	if m["full_admins"] != float64(1) || !strings.Contains(textOf(m["note"]), "every cluster") {
		t.Errorf("global admins: %v %v", m["full_admins"], m["note"])
	}

	// The temporary grants tab says when it lists only the newest requests of the window.
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "access_requests"})
	assertSame(t, "requests cut", m["requests_cut"], `{"shown":2,"total":7,"since":"2026-08-01T00:00:00Z"}`)

	// The API keys tab counts every key and names the expired ones.
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "api_keys"})
	if m["expired"] != float64(1) {
		t.Errorf("expired keys: %v", m["expired"])
	}
}

func TestAccessReview_SearchFindsWhatTheScreensSearchBoxFinds(t *testing.T) {
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, reviewReport(), ""}})
	for _, c := range []struct {
		section, search string
		want            string
	}{
		{"cluster_roles", "PROD-seoul", "[" + reviewGrantProd + "," + reviewGrantCho + "]"},
		{"cluster_roles", " shop ", "[" + reviewGrantProd + "]"},
		{"cluster_roles", "request:rq1", "[" + reviewGrantAlpha + "]"},
		{"cluster_roles", "temporary", "[" + reviewGrantAlpha + "]"},
		// Columns the screen's box does not look in are not searched here either.
		{"cluster_roles", "2026-11-08", "[]"},
		{"cluster_roles", "Read", "[" + reviewGrantCho + "]"},
		{"users", "dormant", "[" + reviewUserBob + "]"},
		{"users", "oidc", "[]"},
		{"users", "sre", "[" + reviewUserAnn + "]"},
		{"api_keys", "kbk_efgh", "[" + reviewKeyBot + "]"},
		{"api_keys", "ci kbk_abcd", "[" + reviewKeyCI + "]"},
		{"api_keys", "10.0.0.9", "[]"},
		{"access_requests", "alpha write", "[" + reviewRequestNew + "]"},
		{"access_requests", "look at logs", "[" + reviewRequestOld + "]"},
		{"access_requests", "fine", "[]"},
		{"roles", "admin.audit.read", "[" + reviewRoleCustom + "]"},
		{"roles", "unused", "[" + reviewRoleCustom + "]"},
	} {
		m, _ := accessReviewAnswer(t, map[string]interface{}{"review_section": c.section, "search": c.search})
		assertSame(t, c.section+" "+c.search, m["rows"], c.want)
		if m["total"] != float64(len(parsed(t, c.want).([]interface{}))) {
			t.Errorf("%s %q total %v", c.section, c.search, m["total"])
		}
	}
}

func TestAccessReview_ASignedOffReportIsTheOneThatWasStored(t *testing.T) {
	// A sign-off from before the counts were kept has neither full_admins nor access_requests_total.
	stored := `{"generated_at":"2026-08-01T00:00:00Z","settings":{"dormant_days":90,"interval_days":90},"since":"2026-05-01T00:00:00Z","last_review":null,"next_due_at":null,"overdue":false,` +
		`"summary":{"users":1,"global_admins":1,"dormant":0,"never_logged_in":0,"locked":0,"dormant_locked":0,"cluster_grants":0,"temporary_grants":0,"api_keys_active":0,"api_keys_expiring":0,"api_keys_unused":0,"access_requests":0},` +
		`"users":` + listWithCredentials(reviewUserAnn) + `,"cluster_roles":[],"api_keys":[],"access_requests":[],"roles":[]}`
	body := withCredentials(`{"id":"r1","reviewed_by":"u1","reviewed_by_email":"boss@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"signed","counts":{"users":1},"snapshot":` + stored + `}`)
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review/history/r1": {200, body, ""}})
	m, _ := accessReviewAnswer(t, map[string]interface{}{"review_id": "r1", "review_section": "users"})
	assertSame(t, "signed off", m["signed_off"], `{"id":"r1","reviewed_by_email":"boss@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"signed"}`)
	assertSame(t, "stored rows", m["rows"], "["+reviewUserAnn+"]")
	if m["generated_at"] != "2026-08-01T00:00:00Z" || m["total"] != float64(1) {
		t.Errorf("stored report: %v %v", m["generated_at"], m["total"])
	}
	if len(*seen) != 1 {
		t.Errorf("%d requests: a stored report is one read", len(*seen))
	}

	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_id": "r1"})
	summary := mapOf(m["summary"])
	if _, has := summary["full_admins"]; has {
		t.Errorf("a count the stored report does not have reads as a number: %v", summary)
	}
	sections := mapOf(m["sections"])
	if _, has := sections["access_requests_total"]; has || sections["users"] != float64(1) {
		t.Errorf("sections: %v", sections)
	}

	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review/history/gone": {404, `{"detail":"Access review not found"}`, ""}})
	m, _ = accessReviewAnswer(t, map[string]interface{}{"review_id": "gone"})
	if m["status"] != "not_found" || !strings.Contains(textOf(m["hint"]), "review_section=history") {
		t.Errorf("no such sign-off: %v", m)
	}
}

func TestAccessReview_PastSignOffsPageWithTheServersTotal(t *testing.T) {
	row := `{"id":"r2","reviewed_by_email":"boss@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"signed","counts":{"users":3,"global_admins":1,"dormant":1,"api_keys_active":1}}`
	body := listWithCredentials(strings.TrimSuffix(row, "}") + `,"reviewed_by":"u1"}`)
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review/history": {200, body, "7"}})
	m, _ := accessReviewAnswer(t, map[string]interface{}{"review_section": "history", "limit": 1, "offset": 5})
	q := (*seen)[0].URL.Query()
	if q.Get("limit") != "1" || q.Get("offset") != "5" {
		t.Fatalf("query: %s", (*seen)[0].URL.RawQuery)
	}
	assertSame(t, "history", m["rows"], "["+row+"]")
	if m["section"] != "history" || m["total"] != float64(7) || m["returned"] != float64(1) || m["offset"] != float64(5) || m["next_offset"] != float64(6) {
		t.Errorf("place: %v %v %v %v", m["total"], m["returned"], m["offset"], m["next_offset"])
	}

	seen = fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review/history": {200, "[" + row + "]", "1"}})
	if m, _ = accessReviewAnswer(t, map[string]interface{}{"review_section": "history"}); m["next_offset"] != nil {
		t.Errorf("the last page: %v", m["next_offset"])
	}
	if q := (*seen)[0].URL.Query(); q.Get("limit") != "25" || q.Get("offset") != "0" {
		t.Errorf("the screen's page by default: %s", (*seen)[0].URL.RawQuery)
	}

	// An answer without the count is an error, as on the screen: not a count of the rows that came.
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review/history": {200, "[" + row + "]", ""}})
	if _, err := handleAccessReview(ctxFor("c1"), map[string]interface{}{"review_section": "history"}, bearer()); err == nil || !strings.Contains(err.Error(), "X-Kubeast-Total") {
		t.Errorf("no total: %v", err)
	}
}

func TestAccessReview_TheWindowOffAndRefused(t *testing.T) {
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, reviewReport(), ""}})
	accessReviewAnswer(t, map[string]interface{}{"since_time": "2026-07-01T00:00:00Z"})
	if got := (*seen)[0].URL.Query().Get("since"); got != "2026-07-01T00:00:00Z" {
		t.Errorf("since: %q", got)
	}
	if _, err := handleAccessReview(ctxFor("c1"), map[string]interface{}{"since_time": "last week"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Errorf("a window that cannot be read: %v", err)
	}
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {404, `{"detail":"Access review is disabled"}`, ""}})
	if m, _ := accessReviewAnswer(t, nil); m["status"] != "unavailable" {
		t.Errorf("off: %v", m)
	}
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {403, `{"detail":"Permission denied"}`, ""}})
	if m, _ := accessReviewAnswer(t, nil); m["status"] != "forbidden" {
		t.Errorf("refused: %v", m)
	}
}

const (
	usageRowAnn = `{"source":"chat","key":"ann@example.com","requests":10,"failures":1,"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"cached_tokens":40,"prompt_chars":900,"token_requests":9,"tool_calls":4,"avg_duration_ms":1250.5,"last_at":"2026-11-06T00:00:00Z"}`
	usageRowBob = `{"source":"chat","key":"bob@example.com","requests":3,"failures":0,"prompt_tokens":30,"completion_tokens":10,"total_tokens":40,"cached_tokens":0,"prompt_chars":90,"token_requests":3,"tool_calls":0,"avg_duration_ms":500,"last_at":"2026-11-05T00:00:00Z"}`
	usageRowRun = `{"source":"investigation","key":"kubeast:investigator","requests":2,"failures":0,"prompt_tokens":20,"completion_tokens":5,"total_tokens":25,"cached_tokens":null,"prompt_chars":null,"token_requests":2,"tool_calls":6,"avg_duration_ms":9000,"last_at":"2026-11-04T00:00:00Z"}`
	usageTotals = `{"chat":{"groups":600,"rows":2,"requests":13,"failures":1,"prompt_tokens":130,"completion_tokens":60,"total_tokens":190,"token_requests":12,"tool_calls":4,"truncated":true},"investigation":{"groups":1,"rows":1,"requests":2,"failures":0,"prompt_tokens":20,"completion_tokens":5,"total_tokens":25,"token_requests":2,"tool_calls":6,"truncated":false},"all":{"groups":601,"rows":3,"requests":15,"failures":1,"prompt_tokens":150,"completion_tokens":65,"total_tokens":215,"token_requests":14,"tool_calls":10,"truncated":true}}`
)

// A usage row's own "key" is the user, model or cluster it adds up, so the fields beside it leave that name out.
func usageReply(rows ...string) string {
	besideKey := strings.Replace(credentialFields, `"key":"`+fakeCredential+`",`, "", 1)
	listed := make([]string, 0, len(rows))
	for _, row := range rows {
		listed = append(listed, strings.TrimSuffix(row, "}")+","+besideKey+"}")
	}
	return withCredentials(`{"since":"2026-10-01T00:00:00Z","until":"2026-11-01T00:00:00Z","group":"user","rows":[` + strings.Join(listed, ",") + `],"limit":500,"truncated":true,"totals":` + usageTotals + `}`)
}

func TestAIUsage_AnswersTheNumbersTheScreenDraws(t *testing.T) {
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/ai-usage": {200, usageReply(usageRowAnn, usageRowBob, usageRowRun), ""}})
	out, err := handleAIUsage(ctxFor("c1"), map[string]interface{}{"usage_group": "model", "since_time": "2026-10-01T00:00:00Z", "until_time": "2026-11-01T00:00:00Z"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "ai_usage", out)
	req := (*seen)[0]
	q := req.URL.Query()
	if req.Method != http.MethodGet || q.Get("group") != "model" || q.Get("since") != "2026-10-01T00:00:00Z" || q.Get("until") != "2026-11-01T00:00:00Z" || q.Has("cluster") {
		t.Fatalf("query: %s %s", req.Method, req.URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+usageRowAnn+","+usageRowBob+","+usageRowRun+"]")
	assertSame(t, "totals", m["totals"], usageTotals)
	assertSame(t, "cuts", m["cuts"], `[{"source":"chat","shown":2,"groups":600}]`)
	if m["since"] != "2026-10-01T00:00:00Z" || m["until"] != "2026-11-01T00:00:00Z" || m["group"] != "user" || m["truncated"] != true || m["listed_limit"] != float64(500) {
		t.Errorf("head: %v", m)
	}
	if m["total"] != float64(3) || m["returned"] != float64(3) || m["next_offset"] != nil {
		t.Errorf("place: %v %v %v", m["total"], m["returned"], m["next_offset"])
	}
	// Ann's row counts tokens for 9 of 10 requests: the screen marks it and says so under the table.
	if !strings.Contains(textOf(m["partial_tokens"]), "no token count") {
		t.Errorf("partial tokens: %v", m["partial_tokens"])
	}
}

func TestAIUsage_PagesAndDefaults(t *testing.T) {
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/ai-usage": {200, usageReply(usageRowAnn, usageRowBob, usageRowRun), ""}})
	out, err := handleAIUsage(ctxFor("c1"), map[string]interface{}{"limit": 1, "offset": 1}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if q.Get("group") != "user" || q.Has("since") || q.Has("until") {
		t.Errorf("the period is the route's own by default: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "page", m["rows"], "["+usageRowBob+"]")
	if m["total"] != float64(3) || m["returned"] != float64(1) || m["offset"] != float64(1) || m["next_offset"] != float64(2) {
		t.Errorf("place: %v %v %v %v", m["total"], m["returned"], m["offset"], m["next_offset"])
	}

	// Every row counts its tokens and no group was cut: nothing to say.
	whole := strings.ReplaceAll(usageTotals, `"truncated":true`, `"truncated":false`)
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/ai-usage": {200, `{"since":"a","until":"b","group":"user","rows":[` + usageRowBob + `],"limit":500,"truncated":false,"totals":` + whole + `}`, ""}})
	out, _ = handleAIUsage(ctxFor("c1"), nil, bearer())
	m = decode(t, out)
	if _, has := m["partial_tokens"]; has {
		t.Errorf("no partial row: %v", m["partial_tokens"])
	}
	if cuts, has := m["cuts"]; has {
		t.Errorf("no cut: %v", cuts)
	}

	if _, err := handleAIUsage(ctxFor("c1"), map[string]interface{}{"since_time": "soon"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Errorf("a window that cannot be read: %v", err)
	}
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/ai-usage": {403, `{"detail":"Permission denied"}`, ""}})
	out, err = handleAIUsage(ctxFor("c1"), nil, bearer())
	if err != nil || decode(t, out)["status"] != "forbidden" {
		t.Errorf("refused: %v %s", err, out)
	}
}

const (
	requestPending = `{"id":"rq1","user_email":"bob@example.com","user_name":"Bob","cluster_id":"alpha","cluster_name":"Alpha","role":"Write","duration_minutes":60,"reason":"deploy fix","status":"pending","created_at":"2026-11-06T00:00:00Z","namespaces":["shop"]}`
	requestDecided = `{"id":"rq2","user_email":"cho@example.com","user_name":"Cho","cluster_id":"self","cluster_name":"Self","role":"Write","duration_minutes":30,"reason":"logs","status":"rejected","created_at":"2026-11-05T00:00:00Z","decided_by_email":"ann@example.com","decided_at":"2026-11-05T01:00:00Z","decision_note":"no"}`
)

func requestReplies(enabled bool, total string, rows ...string) map[string]authReply {
	config := `{"enabled":false,"max_hours":8,"roles":["Write"]}`
	if enabled {
		config = `{"enabled":true,"max_hours":8,"roles":["Write"]}`
	}
	withIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		withIDs = append(withIDs, strings.TrimSuffix(row, "}")+`,"user_id":"u9","decided_by":"u1"}`)
	}
	return map[string]authReply{
		"/api/v1/auth/admin/access-requests":  {200, listWithCredentials(withIDs...), total},
		"/api/v1/auth/access-requests/config": {200, config, ""},
	}
}

func TestAccessRequests_ThePendingTabByDefaultWithTheServersTotal(t *testing.T) {
	seen := fakeAuthReplies(t, requestReplies(true, "41", requestPending))
	out, err := handleAccessRequests(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "access_requests", out)
	for _, req := range *seen {
		if req.Method != http.MethodGet {
			t.Errorf("a read changed something: %s %s", req.Method, req.URL.Path)
		}
		if req.URL.Query().Has("cluster") {
			t.Errorf("a Kubeast-wide read names a cluster: %s", req.URL.RawQuery)
		}
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/auth/admin/access-requests" || q.Get("status") != "pending" || q.Get("limit") != "25" || q.Get("offset") != "0" || q.Has("q") {
		t.Fatalf("request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+requestPending+"]")
	if m["status"] != "pending" || m["total"] != float64(41) || m["returned"] != float64(1) || m["offset"] != float64(0) || m["next_offset"] != float64(1) || m["enabled"] != true {
		t.Errorf("place: %v", m)
	}
	if _, has := m["note"]; has {
		t.Errorf("a note while the feature is on: %v", m["note"])
	}
}

func TestAccessRequests_TheHistorySearchAndPages(t *testing.T) {
	seen := fakeAuthReplies(t, requestReplies(true, "3", requestDecided))
	out, err := handleAccessRequests(ctxFor("c1"), map[string]interface{}{"status": "decided", "search": "cho", "limit": 1, "offset": 2}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if q.Get("status") != "decided" || q.Get("q") != "cho" || q.Get("limit") != "1" || q.Get("offset") != "2" {
		t.Fatalf("query: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+requestDecided+"]")
	if m["total"] != float64(3) || m["offset"] != float64(2) || m["next_offset"] != nil || m["search"] != "cho" {
		t.Errorf("place: %v", m)
	}

	// Off: the screen says so, and what was filed before is still there to read.
	fakeAuthReplies(t, requestReplies(false, "1", requestDecided))
	out, _ = handleAccessRequests(ctxFor("c1"), map[string]interface{}{"status": "decided"}, bearer())
	m = decode(t, out)
	if m["enabled"] != false || m["total"] != float64(1) || !strings.Contains(textOf(m["note"]), "auth.accessRequests.enabled") {
		t.Errorf("off: %v", m)
	}

	if _, err := handleAccessRequests(ctxFor("c1"), map[string]interface{}{"status": "denied"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Errorf("a status the list does not have: %v", err)
	}
	replies := requestReplies(true, "", requestDecided)
	fakeAuthReplies(t, replies)
	if _, err := handleAccessRequests(ctxFor("c1"), nil, bearer()); err == nil || !strings.Contains(err.Error(), "X-Kubeast-Total") {
		t.Errorf("no total: %v", err)
	}
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-requests": {403, `{"detail":"Permission denied"}`, ""}})
	out, err = handleAccessRequests(ctxFor("c1"), nil, bearer())
	if err != nil || decode(t, out)["status"] != "forbidden" {
		t.Errorf("refused: %v %s", err, out)
	}
}

func TestAuditIntegrity_SaysHowFarTheChainIsSealedAndNotThatItIsIntact(t *testing.T) {
	anchor := `{"id":4,"created_at":"2026-11-06T00:00:00Z","from_seq":1,"to_seq":90,"rows":90,"anchor_hash":"ab12cd","sink":"s3","object_key":"audit/4.json","actor":"ann@example.com"}`
	seen := fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/audit/integrity": {200, withCredentials(`{"enabled":true,"seal_seconds":10,"anchor_sink":"s3","anchor_hours":24,"oldest_seq":1,"sealed_through_seq":95,"unsealed_rows":3,"last_anchor":` + withCredentials(anchor) + `}`), ""}})
	out, err := handleAuditIntegrity(ctxFor("c1"), nil, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "audit_integrity", out)
	if len(*seen) != 1 || (*seen)[0].Method != http.MethodGet || (*seen)[0].URL.Query().Has("cluster") {
		t.Fatalf("one read, no cluster: %d %s", len(*seen), (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "last anchor", m["last_anchor"], anchor)
	if m["enabled"] != true || m["seal_seconds"] != float64(10) || m["anchor_sink"] != "s3" || m["anchor_hours"] != float64(24) || m["oldest_seq"] != float64(1) || m["sealed_through_seq"] != float64(95) || m["unsealed_rows"] != float64(3) {
		t.Errorf("status: %v", m)
	}
	if !strings.Contains(textOf(m["note"]), "does not check") {
		t.Errorf("the status is not a check of the chain: %v", m["note"])
	}

	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/audit/integrity": {200, `{"enabled":true,"oldest_seq":0,"sealed_through_seq":0,"unsealed_rows":0,"last_anchor":null}`, ""}})
	out, _ = handleAuditIntegrity(ctxFor("c1"), nil, bearer())
	if la, has := decode(t, out)["last_anchor"]; !has || la != nil {
		t.Errorf("no anchor yet: %v %v", la, has)
	}

	// Off: the screen shows nothing, and zeros would read as an empty chain.
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/audit/integrity": {200, `{"enabled":false,"oldest_seq":0,"sealed_through_seq":0,"unsealed_rows":0,"last_anchor":null}`, ""}})
	out, _ = handleAuditIntegrity(ctxFor("c1"), nil, bearer())
	m = decode(t, out)
	if m["enabled"] != false || !strings.Contains(textOf(m["note"]), "audit.integrity.enabled") {
		t.Errorf("off: %v", m)
	}
	if _, has := m["sealed_through_seq"]; has {
		t.Errorf("off still says a number: %v", m)
	}

	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/audit/integrity": {403, `{"detail":"Permission denied"}`, ""}})
	out, err = handleAuditIntegrity(ctxFor("c1"), nil, bearer())
	if err != nil || decode(t, out)["status"] != "forbidden" {
		t.Errorf("refused: %v %s", err, out)
	}
}

const (
	hygieneSignOffNew = `{"id":"h2","cluster":"c1","reviewed_by_email":"ann@example.com","reviewed_at":"2026-11-01T00:00:00Z","note":"second","counts":{"critical":1,"warning":2,"info":3,"exempt":0}}`
	hygieneSignOffOld = `{"id":"h1","cluster":"c1","reviewed_by_email":"bob@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"","counts":{"critical":4,"warning":5,"info":6,"exempt":1}}`
)

// fakeK8sServiceWithTotal is fakeK8sService whose answer also says how many rows there are (X-Kubeast-Total; "" sends none).
func fakeK8sServiceWithTotal(t *testing.T, respond func(r *http.Request) (status int, body, total string)) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		status, body, total := respond(r)
		if total != "" {
			w.Header().Set("X-Kubeast-Total", total)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	orig := k8sServiceURL
	k8sServiceURL = srv.URL
	t.Cleanup(func() { k8sServiceURL = orig; srv.Close() })
	return &seen
}

// rowCount is the X-Kubeast-Total of a route that answers every row it has.
func rowCount(body string) string {
	var rows []interface{}
	_ = json.Unmarshal([]byte(body), &rows)
	return strconv.Itoa(len(rows))
}

func TestHygieneHistory_TheClustersSignOffsNewestFirst(t *testing.T) {
	seen := fakeK8sServiceWithTotal(t, func(r *http.Request) (int, string, string) {
		return 200, listWithCredentials(strings.TrimSuffix(hygieneSignOffNew, "}")+`,"reviewed_by":"u1"}`, hygieneSignOffOld), "2"
	})
	out, err := handleHygieneHistory(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "hygiene_history", out)
	req := (*seen)[0]
	q := req.URL.Query()
	if req.Method != http.MethodGet || req.URL.Path != "/api/v1/hygiene/history" || q.Get("cluster") != "c1" || req.Header.Get("Authorization") != "Bearer user-token" || q.Get("limit") != "100" || q.Get("offset") != "0" {
		t.Fatalf("request: %s %s %s", req.Method, req.URL.Path, req.URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+hygieneSignOffNew+","+hygieneSignOffOld+"]")
	if m["cluster"] != "c1" || m["total"] != float64(2) || m["returned"] != float64(2) || m["offset"] != float64(0) {
		t.Errorf("head: %v", m)
	}
	if _, has := m["next_offset"]; has {
		t.Errorf("every sign-off came, yet a next page: %v", m["next_offset"])
	}
	if strings.Index(out, `"rows":`) < strings.Index(out, `"total":`) {
		t.Errorf("rows before the place: %.200s", out)
	}

	fakeK8sServiceWithTotal(t, func(r *http.Request) (int, string, string) { return 200, "[]", "0" })
	out, _ = handleHygieneHistory(ctxFor("c1"), nil, bearer())
	m = decode(t, out)
	assertSame(t, "none", m["rows"], "[]")
	if !strings.Contains(textOf(m["hint"]), "not been signed off") {
		t.Errorf("no sign-off yet: %v", m["hint"])
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"cluster hygiene report is disabled"}` })
	out, err = handleHygieneHistory(ctxFor("c1"), nil, bearer())
	if err != nil || decode(t, out)["status"] != "unavailable" {
		t.Errorf("off: %v %s", err, out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 403, `{"detail":"Permission denied"}` })
	out, err = handleHygieneHistory(ctxFor("c1"), nil, bearer())
	if err != nil || decode(t, out)["status"] != "forbidden" {
		t.Errorf("refused: %v %s", err, out)
	}
}

// The Past sign-offs tab pages on the server and its footer says how many there are: the tool reads the same page and count.
func TestHygieneHistory_PagesAsThePastSignOffsTabDoes(t *testing.T) {
	seen := fakeK8sServiceWithTotal(t, func(r *http.Request) (int, string, string) { return 200, "[" + hygieneSignOffOld + "]", "130" })
	out, err := handleHygieneHistory(ctxFor("c1"), args{"limit": 12, "offset": 24}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); q.Get("limit") != "12" || q.Get("offset") != "24" {
		t.Errorf("page asked: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	if m["total"] != float64(130) || m["returned"] != float64(1) || m["offset"] != float64(24) || m["next_offset"] != float64(25) {
		t.Errorf("place: total %v returned %v offset %v next_offset %v", m["total"], m["returned"], m["offset"], m["next_offset"])
	}

	// No limit, or one past what the route answers at most, is the route's most; an offset below zero is the first page.
	for _, given := range []args{{}, {"limit": 0}, {"limit": hygieneHistoryCap + 1}, {"limit": -5, "offset": -3}} {
		seen = fakeK8sServiceWithTotal(t, func(r *http.Request) (int, string, string) { return 200, "[]", "0" })
		if _, err := handleHygieneHistory(ctxFor("c1"), given, bearer()); err != nil {
			t.Fatal(err)
		}
		if q := (*seen)[0].URL.Query(); q.Get("limit") != "100" || q.Get("offset") != "0" {
			t.Errorf("%v asked %s", given, (*seen)[0].URL.RawQuery)
		}
	}
}

// An answer that does not say how many there are is an error, as on the screen: the rows that came are not the count.
func TestHygieneHistory_AnAnswerWithoutTheCountIsAnError(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, "[" + hygieneSignOffNew + "]" })
	if _, err := handleHygieneHistory(ctxFor("c1"), nil, bearer()); err == nil || !strings.Contains(err.Error(), "X-Kubeast-Total") {
		t.Errorf("err = %v", err)
	}
}

// hygieneRoutes answers the sign-offs and the settings, each from its own route.
func hygieneRoutes(t *testing.T, historyStatus int, history string, configStatus int, config string) *[]*http.Request {
	t.Helper()
	return fakeK8sServiceWithTotal(t, func(r *http.Request) (int, string, string) {
		if r.URL.Path == "/api/v1/hygiene/config" {
			return configStatus, config, ""
		}
		return historyStatus, history, rowCount(history)
	})
}

func TestHygieneHistory_SaysHowOftenASignOffIsDue(t *testing.T) {
	seen := hygieneRoutes(t, 200, "["+hygieneSignOffNew+"]", 200, `{"enabled":true,"interval_days":45}`)
	out, err := handleHygieneHistory(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["interval_days"] != float64(45) || m["enabled"] != true {
		t.Errorf("settings: interval_days %v enabled %v in %s", m["interval_days"], m["enabled"], out)
	}
	assertSame(t, "rows", m["rows"], "["+hygieneSignOffNew+"]")
	var asked []string
	for _, r := range *seen {
		asked = append(asked, r.URL.Path+" "+r.URL.Query().Get("cluster"))
	}
	if strings.Join(asked, ",") != "/api/v1/hygiene/history c1,/api/v1/hygiene/config c1" {
		t.Errorf("asked %v", asked)
	}
}

func TestHygieneHistory_AReportThatIsOffStillSaysItsInterval(t *testing.T) {
	hygieneRoutes(t, 404, `{"detail":"cluster hygiene report is disabled"}`, 200, `{"enabled":false,"interval_days":90}`)
	out, err := handleHygieneHistory(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "unavailable" || m["enabled"] != false || m["interval_days"] != float64(90) {
		t.Errorf("%s", out)
	}
}

func TestHygieneHistory_ASettingNotReadIsNotAZero(t *testing.T) {
	hygieneRoutes(t, 200, "["+hygieneSignOffNew+"]", 500, `{"detail":"boom"}`)
	out, err := handleHygieneHistory(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatalf("the sign-offs were read: %v", err)
	}
	m := decode(t, out)
	if got, has := m["interval_days"]; !has || got != nil {
		t.Errorf("interval_days = %v (present %v), want null", got, has)
	}
	if !strings.Contains(textOf(m["settings_error"]), "boom") {
		t.Errorf("settings_error = %v", m["settings_error"])
	}
	assertSame(t, "rows", m["rows"], "["+hygieneSignOffNew+"]")
}

// A caller refused the sign-offs is told that and nothing else, however little the settings route asks itself.
func TestHygieneHistory_ARefusalAsksForNoSettings(t *testing.T) {
	seen := hygieneRoutes(t, 403, `{"detail":"Permission denied"}`, 200, `{"enabled":true,"interval_days":45}`)
	out, err := handleHygieneHistory(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["status"] != "forbidden" {
		t.Errorf("%s", out)
	}
	if _, has := m["interval_days"]; has {
		t.Errorf("a refusal carries a setting: %s", out)
	}
	if len(*seen) != 1 {
		t.Errorf("%d calls", len(*seen))
	}
}

func TestHygieneHistory_TheSettingsNeedThePermissionOfTheScreen(t *testing.T) {
	if got := toolScreenTable["hygiene_history"](args{}); !reflect.DeepEqual(got, []string{"resource.hygiene.scan"}) {
		t.Errorf("permissions: %v", got)
	}
}

func TestHygieneHistory_ASignedOffReportIsTheOneThatWasStored(t *testing.T) {
	report := `{"generated_at":"2026-08-01T00:00:00Z","counts":{"critical":1},"checks":[{"id":"pss-level"}],"findings":[{"check":"pss-level","severity":"critical","name":"a"},{"check":"root","severity":"warning","name":"b"}]}`
	body := withCredentials(`{"id":"h1","cluster":"c1","reviewed_by":"u1","reviewed_by_email":"bob@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"first","counts":{"critical":1,"warning":1,"info":0,"exempt":0},"snapshot":{"cluster":"c1","report":` + report + `}}`)
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleHygieneHistory(ctxFor("c1"), map[string]interface{}{"review_id": "h1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	assertNoCredentials(t, "hygiene_history", out)
	if (*seen)[0].URL.Path != "/api/v1/hygiene/snapshot/h1" || (*seen)[0].URL.Query().Get("cluster") != "c1" {
		t.Fatalf("request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "signed off", m["signed_off"], `{"id":"h1","cluster":"c1","reviewed_by_email":"bob@example.com","reviewed_at":"2026-08-01T00:00:00Z","note":"first","counts":{"critical":1,"warning":1,"info":0,"exempt":0}}`)
	stored := mapOf(m["report"])
	if len(listOf(stored["findings"])) != 2 || stored["findings_total"] != float64(2) || stored["generated_at"] != "2026-08-01T00:00:00Z" {
		t.Errorf("report: %v", stored)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleHygieneHistory(ctxFor("c1"), map[string]interface{}{"review_id": "h1", "severity": "Warning"}, bearer())
	stored = mapOf(decode(t, out)["report"])
	if findings := listOf(stored["findings"]); len(findings) != 1 || mapOf(findings[0])["name"] != "b" || stored["findings_total"] != float64(1) {
		t.Errorf("severity: %v", stored["findings"])
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleHygieneHistory(ctxFor("c1"), map[string]interface{}{"review_id": "h1", "check": "pss-level"}, bearer())
	stored = mapOf(decode(t, out)["report"])
	if findings := listOf(stored["findings"]); len(findings) != 1 || mapOf(findings[0])["name"] != "a" {
		t.Errorf("check: %v", stored["findings"])
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"hygiene review not found"}` })
	out, _ = handleHygieneHistory(ctxFor("c1"), map[string]interface{}{"review_id": "gone"}, bearer())
	if m := decode(t, out); m["status"] != "not_found" || !strings.Contains(textOf(m["hint"]), "without review_id") {
		t.Errorf("no such sign-off: %v", m)
	}
}

// Every field that says what a screen says stays as it is; only the mail address follows ai.redaction.pii, here where
// tool-server masks what any tool returns.
func TestAdminReads_MailAddressesFollowTheSettingAndTheRestStays(t *testing.T) {
	orig := redactOpts
	t.Cleanup(func() { redactOpts = orig })

	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, reviewReport(), ""}, "/api/v1/auth/admin/ai-usage": {200, usageReply(usageRowAnn, usageRowRun), ""}})
	keys, err := handleAccessReview(ctxFor("c1"), map[string]interface{}{"review_section": "api_keys"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	usage, err := handleAIUsage(ctxFor("c1"), nil, bearer())
	if err != nil {
		t.Fatal(err)
	}

	redactOpts = redact.Options{Enabled: true}
	shown, _ := redactToolOutput(keys)
	m := decode(t, shown)
	first := firstRow(m)
	if first["owner_email"] != "ann@example.com" || first["key_prefix"] != "kbk_abcd1234" {
		t.Errorf("pii off keeps the address and the prefix: %v", first)
	}
	shownUsage, _ := redactToolOutput(usage)
	row := firstRow(decode(t, shownUsage))
	if row["key"] != "ann@example.com" || row["token_requests"] != float64(9) || row["prompt_tokens"] != float64(100) || row["total_tokens"] != float64(150) {
		t.Errorf("pii off keeps the row: %v", row)
	}

	redactOpts = redact.Options{Enabled: true, PII: true}
	shown, stats := redactToolOutput(keys)
	if strings.Contains(shown, "@example.com") || !strings.Contains(shown, "<EMAIL") || stats == nil {
		t.Errorf("pii on masks the address: %s", shown)
	}
	first = firstRow(decode(t, shown))
	if first["key_prefix"] != "kbk_abcd1234" || first["role_ceiling"] != "Read" {
		t.Errorf("pii on keeps the rest: %v", first)
	}
	shownUsage, _ = redactToolOutput(usage)
	row = firstRow(decode(t, shownUsage))
	if strings.Contains(shownUsage, "@example.com") || row["token_requests"] != float64(9) {
		t.Errorf("pii on keeps the numbers: %v", row)
	}
}

// Free text a person typed goes through the masks like any other tool result.
func TestAdminReads_ACredentialTypedIntoAReasonIsMasked(t *testing.T) {
	orig := redactOpts
	t.Cleanup(func() { redactOpts = orig })
	redactOpts = redact.Options{Enabled: true}
	typed := strings.Replace(requestPending, "deploy fix", "use Authorization: Bearer fakefakefakefakefakefake", 1)
	fakeAuthReplies(t, requestReplies(true, "1", typed))
	out, err := handleAccessRequests(ctxFor("c1"), nil, bearer())
	if err != nil {
		t.Fatal(err)
	}
	shown, _ := redactToolOutput(out)
	if strings.Contains(shown, "fakefakefakefakefakefake") {
		t.Errorf("a token in a reason reached the answer: %s", shown)
	}
}

var adminReadTools = map[string]string{
	"access_review":   "admin.review.read",
	"ai_usage":        "admin.audit.read",
	"access_requests": "admin.users.update",
	"audit_integrity": "admin.audit.read",
	"hygiene_history": "resource.hygiene.scan",
	// Admin → Investigations, AI Models and Session recordings.
	"investigations":     "admin.investigations.read",
	"ai_models":          "admin.ai_models.*",
	"session_recordings": "admin.sessions.read",
}

type fixedToken struct{ payload auth.TokenPayload }

func (f fixedToken) Validate(string) (auth.TokenPayload, error) { return f.payload, nil }

// The report's route answers the cluster's own key or the all-cluster one, and so do its tools; another cluster's key opens nothing.
func TestHygieneTools_AskTheClustersKeyOrTheAllClusterOne(t *testing.T) {
	for _, tool := range []string{"hygiene", "hygiene_history"} {
		for name, c := range map[string]struct {
			perms auth.PermissionMatrix
			want  int
		}{
			"the cluster's key": {auth.PermissionMatrix{"c1": {"ai.tool.*", "resource.hygiene.scan"}}, 0},
			"the global key":    {auth.PermissionMatrix{"c1": {"ai.tool.*"}, "*": {"admin.hygiene.read"}}, 0},
			"another cluster's": {auth.PermissionMatrix{"c1": {"ai.tool.*"}, "c2": {"resource.hygiene.scan"}}, http.StatusForbidden},
			"read everything":   {auth.PermissionMatrix{"c1": {"ai.tool.*", "resource.*.read"}}, http.StatusForbidden},
		} {
			if _, status, err := authorizeToolCall(fixedToken{auth.TokenPayload{Perms: c.perms}}, bearer(), tool, "c1", args{}); status != c.want {
				t.Errorf("%s, %s: status %d (%v), want %d", tool, name, status, err, c.want)
			}
		}
	}
}

func TestAdminReads_AskThePermissionOfTheirScreen(t *testing.T) {
	headers := bearer()
	for tool, permission := range adminReadTools {
		got, listed := toolAppPermissions(tool, args{})
		if !listed || len(got) != 1 || got[0] != permission {
			t.Errorf("%s asks %v listed=%v, want %s", tool, got, listed, permission)
		}
		held := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {permission, "ai.tool." + tool}}}
		if _, status, err := authorizeToolCall(fixedToken{held}, headers, tool, "c1", args{}); status != 0 || err != nil {
			t.Errorf("%s with %s: %d %v", tool, permission, status, err)
		}
		// The tool's own permission alone is not the screen's, and the Read role's seed holds neither.
		toolOnly := auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"ai.tool.*", "resource.*.read"}}}
		status := 0
		var err error
		if _, status, err = authorizeToolCall(fixedToken{toolOnly}, headers, tool, "c1", args{}); status != http.StatusForbidden || err == nil || !strings.Contains(err.Error(), permission) {
			t.Errorf("%s without %s: %d %v", tool, permission, status, err)
		}
		screenOnly := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {permission}}}
		if _, status, _ = authorizeToolCall(fixedToken{screenOnly}, headers, tool, "c1", args{}); status != http.StatusForbidden {
			t.Errorf("%s without ai.tool.%s: %d", tool, tool, status)
		}
	}
}

func TestAdminReads_AreToolsAndAGrantLimitedToNamespacesIsRefused(t *testing.T) {
	registry := buildToolRegistry()
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	for tool := range adminReadTools {
		if _, ok := registry[tool]; !ok {
			t.Errorf("%s is not registered", tool)
		}
		if err := namespaceGate(scoped, "c", tool, args{}); !errors.Is(err, errNamespaceScope) || !strings.Contains(err.Error(), "spans the cluster") {
			t.Errorf("%s: %v", tool, err)
		}
	}
}

func TestAdminReads_ArgumentsKeepToTheirShape(t *testing.T) {
	for _, a := range []map[string]interface{}{
		{"review_section": "summary"}, {"review_section": "cluster_roles"}, {"review_section": "history"},
		{"review_id": "0f3b0b5e-8a6d-4f7a-9a0f-5d1a2b3c4d5e"}, {"usage_group": "cluster"}, {"status": "decided"},
		{"search": "prod seoul"}, {"since_time": "7d"}, {"until_time": "2026-11-01T00:00:00Z"},
	} {
		if err := validateToolArgs(a); err != nil {
			t.Errorf("%v should pass: %v", a, err)
		}
	}
	for _, a := range []map[string]interface{}{
		{"review_section": "secrets"}, {"review_id": "../users"}, {"review_id": "a/b"}, {"review_id": ".."}, {"review_id": "a%2fb"}, {"usage_group": "team"},
		{"status": "Not A Word"}, {"search": "a\nb"},
	} {
		if err := validateToolArgs(a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", a, err)
		}
	}
}

// A model reads a long answer cut at its tool result length: where it stands comes before the rows.
func TestAdminReads_ThePlaceComesBeforeTheRows(t *testing.T) {
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, reviewReport(), ""}, "/api/v1/auth/admin/ai-usage": {200, usageReply(usageRowAnn), ""}})
	section, err := handleAccessReview(ctxFor("c1"), map[string]interface{}{"review_section": "users"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	usage, err := handleAIUsage(ctxFor("c1"), nil, bearer())
	if err != nil {
		t.Fatal(err)
	}
	for what, out := range map[string]string{"access_review": section, "ai_usage": usage} {
		rows := strings.Index(out, `"rows":`)
		for _, key := range []string{`"total":`, `"returned":`, `"offset":`} {
			if at := strings.Index(out, key); at < 0 || rows < 0 || at > rows {
				t.Errorf("%s: %s at %d, rows at %d", what, key, at, rows)
			}
		}
	}
}
