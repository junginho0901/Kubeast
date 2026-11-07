package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A failure says which service failed: auth-service's tools do not read k8s-service.
func TestFailureNamesTheServiceThatFailed(t *testing.T) {
	const boom = `{"detail":"fake failure"}`
	cases := []struct {
		tool    string
		call    args
		path    string
		service string
	}{
		{"access_review", args{}, "/api/v1/auth/admin/access-review", "auth-service"},
		{"access_review", args{"review_section": "history"}, "/api/v1/auth/admin/access-review/history", "auth-service"},
		{"ai_usage", args{}, "/api/v1/auth/admin/ai-usage", "auth-service"},
		{"access_requests", args{}, "/api/v1/auth/admin/access-requests", "auth-service"},
		{"audit_integrity", args{}, "/api/v1/auth/admin/audit/integrity", "auth-service"},
		{"audit_search", args{}, "/api/v1/auth/admin/audit-logs", "auth-service"},
		{"clusters_list", args{}, "/api/v1/clusters", "auth-service"},
	}
	for _, c := range cases {
		t.Run(c.tool+" "+c.path, func(t *testing.T) {
			fakeAuthReplies(t, map[string]authReply{c.path: {500, boom, ""}})
			tool := buildToolRegistry()[c.tool]
			_, err := tool.Handler(ctxWithPayload("self", holderOf()), c.call, bearer())
			if err == nil {
				t.Fatal("no error")
			}
			if !strings.Contains(err.Error(), c.service) || !strings.Contains(err.Error(), "fake failure") {
				t.Errorf("err = %q, want it to name %s", err, c.service)
			}
			if strings.Contains(err.Error(), "k8s-service") {
				t.Errorf("err = %q names a service that was not called", err)
			}
		})
	}
	t.Run("k8s-service's own tool", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) { return 500, boom })
		_, err := handleHygieneHistory(ctxWithPayload("self", holderOf()), args{}, bearer())
		if err == nil || !strings.Contains(err.Error(), "k8s-service") {
			t.Errorf("err = %v", err)
		}
	})
}

// reviewOfSize is a report whose answer takes more than size bytes, every row of it a real one.
func reviewOfSize(t *testing.T, size int) string {
	t.Helper()
	reason := strings.Repeat("r", 500)
	row := `{"requester_email":"bob@example.com","cluster":"alpha","role":"Write","duration_minutes":60,"reason":"` + reason + `","status":"approved","created_at":"2026-11-01T00:00:00Z","decision_note":"` + reason + `"}`
	count := size/len(row) + 1
	rows := strings.TrimSuffix(strings.Repeat(row+",", count), ",")
	report := `{"generated_at":"2026-11-07T01:00:00Z","settings":` + reviewSetting + `,"summary":` + reviewSummary + `,"users":[` + reviewUserAnn + `],"cluster_roles":[],"api_keys":[],"roles":[],"access_requests_total":` + jsonNumber(count) + `,"access_requests":[` + rows + `]}`
	if !json.Valid([]byte(report)) {
		t.Fatal("the report is not JSON")
	}
	return report
}

func jsonNumber(n int) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

// The screen opens a report of any length, so the tool reads one that passes what other answers hold.
func TestAccessReview_AReportLongerThanOtherAnswersIsRead(t *testing.T) {
	report := reviewOfSize(t, 9<<20)
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, report, ""}})
	m, _ := accessReviewAnswer(t, args{})
	sections := mapOf(m["sections"])
	if sections["access_requests"] == nil || sections["access_requests"].(float64) < 5000 {
		t.Errorf("sections: %v", sections)
	}
	assertSame(t, "summary", m["summary"], reviewSummary)
}

// Past what a tool can hold the answer says so and where to read it, not that it could not be read.
func TestAccessReview_AReportPastWhatAToolHoldsSaysSo(t *testing.T) {
	big := `{"users":[` + `"` + strings.Repeat("x", 65<<20) + `"` + `]}`
	fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/access-review": {200, big, ""}})
	out, err := handleAccessReview(ctxFor("c1"), args{}, bearer())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	m := decode(t, out)
	if m["status"] != "failed" || m["code"] != "too_large" || !strings.Contains(textOf(m["hint"]), "Access review") {
		t.Errorf("answer: %.300s", out)
	}
}

// The Size column: an interrupted recording counts what was uploaded, any other what was recorded, or what was uploaded before that is known.
func TestSessionRecordings_KeptBytesIsTheSizeTheScreenShows(t *testing.T) {
	for _, c := range []struct {
		name     string
		status   string
		bytes    float64
		uploaded float64
		want     float64
	}{
		{"uploaded", "uploaded", 4096, 4096, 4096},
		{"interrupted keeps what was uploaded", "interrupted", 100, 40, 40},
		{"interrupted with nothing uploaded", "interrupted", 100, 0, 0},
		{"still recording with no size yet", "recording", 0, 50, 50},
		{"cut at the limit", "uploaded", 9000, 4096, 9000},
	} {
		t.Run(c.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]interface{}{"id": "rec", "status": c.status, "bytes": c.bytes, "uploaded_bytes": c.uploaded})
			recordingRoutes(t, 200, "["+string(raw)+"]", 200, `{"enabled":true}`)
			m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{}))
			if got := firstRow(m)["kept_bytes"]; got != c.want {
				t.Errorf("kept_bytes = %v, want %v", got, c.want)
			}
		})
	}
	t.Run("one recording", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, `{"id":"rec","status":"interrupted","bytes":100,"uploaded_bytes":40}`
		})
		m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{"recording_id": "rec"}))
		if got := mapOf(m["recording"])["kept_bytes"]; got != float64(40) {
			t.Errorf("kept_bytes = %v", got)
		}
	})
}

func TestAIModels_EnabledOnlyAsksTheRouteForThose(t *testing.T) {
	seen := aiModelRoutes(t, 200, "["+modelRowChat+"]", 200, `{"providers":{}}`)
	runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{"enabled_only": true})
	if got := (*seen)[0].URL.Query().Get("enabled_only"); got != "true" {
		t.Errorf("enabled_only = %q: %s", got, (*seen)[0].URL)
	}
	seen = aiModelRoutes(t, 200, "["+modelRowChat+"]", 200, `{"providers":{}}`)
	runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})
	if (*seen)[0].URL.Query().Has("enabled_only") {
		t.Errorf("without it the route lists every model: %s", (*seen)[0].URL)
	}
}

// ai-service reads a key through either field, so a variable named in the older one is a key the model runs with.
func TestAIModels_KeyEnvSetCountsTheOlderField(t *testing.T) {
	for _, c := range []struct {
		name string
		key  string
		want interface{}
	}{
		{"only the older field", `"api_key_env":null,"api_key_secret_key":"FAKE_KEY_VARIABLE"`, true},
		{"both", `"api_key_env":"FAKE_KEY_VARIABLE","api_key_secret_key":"FAKE_KEY_VARIABLE"`, true},
		{"the older field empty", `"api_key_env":null,"api_key_secret_key":""`, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			aiModelRoutes(t, 200, `[{"id":1,"name":"m","provider":"openai","model":"x","enabled":true,"is_default":false,"tier":"default","used_for":[],`+c.key+`}]`, 200, `{"providers":{}}`)
			out := runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})
			if got := firstRow(decode(t, out))["key_env_set"]; got != c.want {
				t.Errorf("key_env_set = %v, want %v", got, c.want)
			}
			if strings.Contains(out, "FAKE_KEY_VARIABLE") {
				t.Errorf("the answer names the variable: %s", out)
			}
		})
	}
}

// Kubeast's own records: their routes ask an all-cluster permission and never look at a grant's namespaces.
var recordTools = map[string]string{
	"audit_search":       "admin.audit.read",
	"access_review":      "admin.review.read",
	"ai_usage":           "admin.audit.read",
	"access_requests":    "admin.users.update",
	"audit_integrity":    "admin.audit.read",
	"investigations":     "admin.investigations.read",
	"ai_models":          "admin.ai_models.*",
	"session_recordings": "admin.sessions.read",
}

func TestNamespaceGate_AnAllClusterHolderReadsKubeastsRecordsFromAnyCluster(t *testing.T) {
	limited := map[string][]string{"c": {"shop"}}
	for tool, permission := range recordTools {
		holder := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {permission}, "c": {"ai.tool.*"}}, Namespaces: limited}
		if err := namespaceGate(holder, "c", tool, args{}); err != nil {
			t.Errorf("%s with %s on all clusters: %v", tool, permission, err)
		}
		// Only on this cluster: the route asks all clusters, so nothing opens.
		onThisOne := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*", permission}}, Namespaces: limited}
		if err := namespaceGate(onThisOne, "c", tool, args{}); !errors.Is(err, errNamespaceScope) {
			t.Errorf("%s with %s on this cluster: %v", tool, permission, err)
		}
		other := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"admin.nothing.read"}, "c": {"ai.tool.*"}}, Namespaces: limited}
		if err := namespaceGate(other, "c", tool, args{}); !errors.Is(err, errNamespaceScope) {
			t.Errorf("%s with another permission: %v", tool, err)
		}
	}
	// These read the cluster itself; a global permission does not take a limited grant past them here either.
	everything := auth.TokenPayload{Perms: auth.PermissionMatrix{"*": {"*"}, "c": {"ai.tool.*"}}, Namespaces: limited}
	for _, tool := range []string{"hygiene", "hygiene_history", "nodes_log", "nodes_stats_summary", "prometheus_query", "alerts_list", "get_node_metrics"} {
		if err := namespaceGate(everything, "c", tool, args{}); !errors.Is(err, errNamespaceScope) {
			t.Errorf("%s: %v", tool, err)
		}
	}
}
