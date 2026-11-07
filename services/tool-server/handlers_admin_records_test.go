package main

import (
	"errors"
	"net/http"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const (
	recordingRowA = `{"id":"rec-a","kind":"exec","user_email":"ann@example.com","cluster":"self","namespace":"shop","target":"web-1","container":"app","storage":"s3","started_at":"2026-11-01T01:00:00Z","ended_at":"2026-11-01T01:10:00Z","bytes":4096,"uploaded_bytes":4096,"parts":2,"status":"uploaded","truncated":false}`
	recordingRowB = `{"id":"rec-b","kind":"node-shell","user_email":"bob@example.com","cluster":"alpha","target":"node-1","storage":"s3","started_at":"2026-11-01T00:00:00Z","bytes":100,"uploaded_bytes":0,"parts":0,"status":"interrupted","truncated":true,"last_error":"spool file lost; parts uploaded before are kept"}`
	// What a recording's answer might hold beside its details: no answer may carry any of it.
	recordingContentFields = `"user_id":"fake-user-id","location":"fake-recording-place","cast":"fake-terminal-output","transcript":"fake-terminal-output","content":"fake-terminal-output"`
)

// As the answer gives them: with the size the screen shows.
var (
	recordingRowAShown = strings.TrimSuffix(recordingRowA, "}") + `,"kept_bytes":4096}`
	recordingRowBShown = strings.TrimSuffix(recordingRowB, "}") + `,"kept_bytes":0}`
)

func withRecordingContent(row string) string {
	return strings.TrimSuffix(row, "}") + "," + recordingContentFields + "}"
}

func assertNoRecordingContent(t *testing.T, out string) {
	t.Helper()
	for _, held := range []string{"fake-terminal-output", "fake-recording-place", "fake-user-id", `"cast"`, `"transcript"`, `"location"`} {
		if strings.Contains(out, held) {
			t.Errorf("the answer carries %s: %s", held, out)
		}
	}
}

// recordingRoutes answers the Session recordings routes; a read of what the terminal showed fails the test.
func recordingRoutes(t *testing.T, listStatus int, list string, configStatus int, config string) *[]*http.Request {
	t.Helper()
	return fakeK8sService(t, func(r *http.Request) (int, string) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/cast"):
			t.Errorf("read what the terminal showed: %s", r.URL)
			return 200, `fake-terminal-output`
		case r.URL.Path == "/api/v1/recordings/config":
			return configStatus, config
		case r.URL.Path == "/api/v1/recordings":
			return listStatus, list
		}
		return 404, `{"detail":"recording not found"}`
	})
}

func TestSessionRecordings_ListsTheDetailsTheScreenListsAcrossClusters(t *testing.T) {
	seen := recordingRoutes(t, 200, "["+withRecordingContent(recordingRowA)+","+withRecordingContent(recordingRowB)+"]", 200, `{"enabled":true}`)
	out := runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{})
	assertNoRecordingContent(t, out)

	list := (*seen)[0]
	if list.URL.Path != "/api/v1/recordings" || list.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s auth=%q", list.URL, list.Header.Get("Authorization"))
	}
	// The screen lists every cluster's and the route reads cluster as a filter, not as the one a request is routed to.
	if _, filtered := list.URL.Query()["cluster"]; filtered {
		t.Errorf("the list was narrowed to a cluster: %s", list.URL.RawQuery)
	}
	if list.URL.Query().Get("limit") != "26" || list.URL.Query().Get("offset") != "" {
		t.Errorf("a page and one row past it, as the screen asks: %s", list.URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+recordingRowAShown+","+recordingRowBShown+"]")
	if m["returned"] != float64(2) || m["offset"] != float64(0) || m["next_offset"] != nil || m["enabled"] != true {
		t.Errorf("place: %v", m)
	}
	if strings.Index(out, `"rows":`) < strings.Index(out, `"returned":`) {
		t.Errorf("rows before the place: %.200s", out)
	}
	if !strings.Contains(textOf(m["note"]), "Session recordings screen") || !strings.Contains(textOf(m["note"]), "audited") {
		t.Errorf("the answer should say where the terminal's output is opened: %v", m["note"])
	}
}

func TestSessionRecordings_ThereIsNoTotalSoOneRowPastThePageSaysThereIsMore(t *testing.T) {
	seen := recordingRoutes(t, 200, "["+recordingRowA+","+recordingRowB+"]", 200, `{"enabled":true}`)
	out := runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{"limit": 1, "offset": 3})
	q := (*seen)[0].URL.Query()
	if q.Get("limit") != "2" || q.Get("offset") != "3" {
		t.Errorf("query: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+recordingRowAShown+"]")
	if m["returned"] != float64(1) || m["offset"] != float64(3) || m["next_offset"] != float64(4) {
		t.Errorf("place: %v", m)
	}
	if _, has := m["total"]; has {
		t.Errorf("the route counts nothing, so there is no total: %v", m["total"])
	}
}

func TestSessionRecordings_FiltersAsTheRouteDoes(t *testing.T) {
	seen := recordingRoutes(t, 200, "[]", 200, `{"enabled":true}`)
	runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{"actor_email": "ann", "recording_kind": "node-shell", "cluster_id": "alpha"})
	q := (*seen)[0].URL.Query()
	for key, want := range map[string]string{"user": "ann", "kind": "node-shell", "cluster": "alpha"} {
		if q.Get(key) != want {
			t.Errorf("%s=%q, want %q", key, q.Get(key), want)
		}
	}
}

func TestSessionRecordings_OneRecordingIsItsDetailsAndNeverWhatTheTerminalShowed(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/cast") {
			t.Errorf("read what the terminal showed: %s", r.URL)
		}
		return 200, withRecordingContent(recordingRowB)
	})
	out := runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{"recording_id": "rec-b"})
	assertNoRecordingContent(t, out)
	if len(*seen) != 1 || (*seen)[0].URL.Path != "/api/v1/recordings/rec-b" {
		t.Fatalf("requests: %d, first %s", len(*seen), (*seen)[0].URL)
	}
	if _, filtered := (*seen)[0].URL.Query()["cluster"]; filtered {
		t.Errorf("one recording was narrowed to a cluster: %s", (*seen)[0].URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "recording", m["recording"], recordingRowBShown)
	if !strings.Contains(textOf(m["note"]), "Session recordings screen") {
		t.Errorf("note: %v", m["note"])
	}
}

func TestSessionRecordings_RecordingOffStillListsTheEarlierOnes(t *testing.T) {
	recordingRoutes(t, 200, "["+recordingRowA+"]", 200, `{"enabled":false}`)
	m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{}))
	assertSame(t, "rows", m["rows"], "["+recordingRowAShown+"]")
	if m["enabled"] != false || !strings.Contains(textOf(m["note"]), "sessionRecording.enabled") {
		t.Errorf("off: %v", m)
	}
}

func TestSessionRecordings_ASettingNotReadIsNotOff(t *testing.T) {
	recordingRoutes(t, 200, "["+recordingRowA+"]", 500, `{"detail":"boom"}`)
	m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{}))
	assertSame(t, "rows", m["rows"], "["+recordingRowAShown+"]")
	if got, has := m["enabled"]; !has || got != nil {
		t.Errorf("enabled = %v (present %v), want null", got, has)
	}
	if !strings.Contains(textOf(m["settings_error"]), "boom") {
		t.Errorf("settings_error = %v", m["settings_error"])
	}
}

func TestSessionRecordings_NoRowsSaySo(t *testing.T) {
	for _, empty := range []string{"[]", "null"} {
		recordingRoutes(t, 200, empty, 200, `{"enabled":true}`)
		m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{}))
		if rows, ok := m["rows"].([]interface{}); !ok || len(rows) != 0 || m["returned"] != float64(0) || textOf(m["hint"]) == "" {
			t.Errorf("%s: %v", empty, m)
		}
	}
}

func TestSessionRecordings_ARefusalIsAResultAndAsksNothingMore(t *testing.T) {
	seen := recordingRoutes(t, 403, `{"detail":"Permission denied"}`, 200, `{"enabled":true}`)
	out := runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{})
	if decode(t, out)["status"] != "forbidden" || len(*seen) != 1 {
		t.Errorf("%d requests: %s", len(*seen), out)
	}

	fakeK8sService(t, func(*http.Request) (int, string) { return 404, `{"detail":"recording not found"}` })
	out = runTool(t, ctxWithPayload("self", holderOf()), "session_recordings", args{"recording_id": "gone"})
	if m := decode(t, out); m["status"] != "not_found" || !strings.Contains(textOf(m["hint"]), "without recording_id") {
		t.Errorf("no such recording: %v", m)
	}
}

const (
	investigationRowA = `{"id":"inv-a","cluster":"self","alertname":"HighLoad","severity":"warning","namespace":"shop","status":"done","skip_reason":"","received_at":"2026-11-01T00:00:00Z","started_at":"2026-11-01T00:00:01Z","finished_at":"2026-11-01T00:01:01Z","repeat_count":2,"last_seen_at":"2026-11-01T00:05:00Z","requested_by":"ann@example.com","model":"small","total_tokens":900,"iterations":3,"tool_call_count":1,"duration_ms":60000}`
	investigationRowB = `{"id":"inv-b","cluster":"alpha","alertname":"DiskFull","severity":"critical","namespace":"","status":"skipped","skip_reason":"budget spent","received_at":"2026-11-01T00:00:00Z","started_at":null,"finished_at":null,"repeat_count":1,"last_seen_at":"2026-11-01T00:00:00Z","requested_by":"","model":"","total_tokens":null,"iterations":0,"tool_call_count":0,"duration_ms":null}`
	// What the route answers for the screen's own wording: the reason's words are in skip_reason.
	investigationScreenFields = `"skip_reason_key":"budget","skip_reason_args":{"n":1}`
)

func investigationDetail() string {
	return strings.TrimSuffix(investigationRowA, "}") + `,` + investigationScreenFields + `,"fingerprint":"fp1","labels":{"pod":"web-1"},"annotations":{"summary":"load is high"},"starts_at":"2026-11-01T00:00:00Z",` +
		`"generator_url":"https://prom.example/graph","alertmanager_url":"https://am.example","provider":"anthropic","prompt_tokens":800,"completion_tokens":100,` +
		`"tool_calls":[{"tool":"k8s_get_resources","args":{"resource_type":"pods"},"step":1,"result_chars":120,"access":{"kind":"investigator"},"fake_field":"fake-credential-value"}],` +
		`"report":"The load comes from web-1.","error":""}`
}

func TestInvestigations_TheListIsThePageTheScreenReads(t *testing.T) {
	seen := fakeAIService(t, func(*http.Request) (int, string) {
		return 200, `{"items":[` + withCredentials(strings.TrimSuffix(investigationRowA, "}")+","+investigationScreenFields+"}") + `,` + investigationRowB + `],"total":7,"limit":25,"offset":0}`
	})
	out := runTool(t, ctxWithPayload("self", holderOf()), "investigations", args{})
	assertNoCredentials(t, "investigations", out)

	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/ai/investigations" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL)
	}
	if _, filtered := req.URL.Query()["cluster"]; filtered {
		t.Errorf("the screen lists every cluster's reports until a cluster is asked: %s", req.URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], "["+investigationRowA+","+investigationRowB+"]")
	if m["total"] != float64(7) || m["returned"] != float64(2) || m["next_offset"] != float64(2) {
		t.Errorf("place: %v", m)
	}
	if strings.Index(out, `"rows":`) < strings.Index(out, `"total":`) {
		t.Errorf("rows before the place: %.200s", out)
	}
}

func TestInvestigations_FiltersAndPagesAsTheRouteDoes(t *testing.T) {
	seen := fakeAIService(t, func(*http.Request) (int, string) {
		return 200, `{"items":[` + investigationRowB + `],"total":3,"limit":1,"offset":2}`
	})
	out := runTool(t, ctxWithPayload("self", holderOf()), "investigations", args{"status": "skipped", "cluster_id": "alpha", "limit": 1, "offset": 2})
	q := (*seen)[0].URL.Query()
	for key, want := range map[string]string{"status": "skipped", "cluster": "alpha", "limit": "1", "offset": "2"} {
		if q.Get(key) != want {
			t.Errorf("%s=%q, want %q", key, q.Get(key), want)
		}
	}
	m := decode(t, out)
	if m["total"] != float64(3) || m["offset"] != float64(2) || m["next_offset"] != nil {
		t.Errorf("the last page: %v", m)
	}
}

func TestInvestigations_NoReportsSaySoAndNameWhatMakesThem(t *testing.T) {
	fakeAIService(t, func(*http.Request) (int, string) { return 200, `{"items":[],"total":0,"limit":25,"offset":0}` })
	m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "investigations", args{}))
	if rows, ok := m["rows"].([]interface{}); !ok || len(rows) != 0 || m["total"] != float64(0) || !strings.Contains(textOf(m["hint"]), "features.alertInvestigation") {
		t.Errorf("%v", m)
	}
}

func TestInvestigations_OneReportReadsTheRouteThatRecordsItsView(t *testing.T) {
	seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, investigationDetail() })
	out := runTool(t, ctxWithPayload("self", holderOf()), "investigations", args{"investigation_id": "inv-a"})
	assertNoCredentials(t, "investigations", out)
	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/ai/investigations/inv-a" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL)
	}
	if req.Header.Get("User-Agent") != "kubeast-tool-server" {
		t.Errorf("the route's audit row should say a tool read it: %q", req.Header.Get("User-Agent"))
	}
	m := decode(t, out)
	if m["report"] != "The load comes from web-1." || m["provider"] != "anthropic" || m["status"] != "done" || m["generator_url"] != "https://prom.example/graph" || m["prompt_tokens"] != float64(800) {
		t.Errorf("report: %v", m)
	}
	assertSame(t, "labels", m["labels"], `{"pod":"web-1"}`)
	assertSame(t, "annotations", m["annotations"], `{"summary":"load is high"}`)
	assertSame(t, "tool calls", m["tool_calls"], `[{"tool":"k8s_get_resources","args":{"resource_type":"pods"},"step":1,"result_chars":120,"access":{"kind":"investigator"}}]`)
	if _, has := m["skip_reason_key"]; has {
		t.Errorf("the screen's catalog key went along: %v", m)
	}
	// A long report is cut at the model's limit: what it is about comes first and what can be read elsewhere last.
	for _, order := range [][2]string{{`"status":`, `"report":`}, {`"report":`, `"tool_calls":`}, {`"tool_calls":`, `"labels":`}} {
		if strings.Index(out, order[0]) > strings.Index(out, order[1]) {
			t.Errorf("%s after %s: %.300s", order[0], order[1], out)
		}
	}
}

func TestInvestigations_ARefusalIsAResult(t *testing.T) {
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"detail":"permission required: admin.investigations.read"}`, "forbidden"},
		{404, `{"detail":"investigation not found"}`, "not_found"},
		{503, `{"detail":"audit unavailable"}`, "audit_unavailable"},
		{429, `{"detail":"too many"}`, "rate_limited"},
	} {
		fakeAIService(t, func(*http.Request) (int, string) { return c.status, c.body })
		out := runTool(t, ctxWithPayload("self", holderOf()), "investigations", args{"investigation_id": "inv-a"})
		if m := decode(t, out); m["status"] != c.want {
			t.Errorf("%d: %s", c.status, out)
		}
	}
	fakeAIService(t, func(*http.Request) (int, string) { return 400, `{"detail":"status must be one of"}` })
	if err := toolError(ctxWithPayload("self", holderOf()), "investigations", args{"status": "nope"}); !errors.Is(err, errBadRequest) {
		t.Errorf("a status the route does not have: %v", err)
	}
	fakeAIService(t, func(*http.Request) (int, string) { return 500, `{"detail":"boom"}` })
	if err := toolError(ctxWithPayload("self", holderOf()), "investigations", args{}); err == nil || !strings.Contains(err.Error(), "ai-service") {
		t.Errorf("the failing service should be named: %v", err)
	}
}

const (
	modelRowChat    = `{"id":1,"name":"main","provider":"anthropic","model":"big-1","enabled":true,"is_default":true,"tier":"default","used_for":["chat","investigation"],"created_at":"2026-01-01T00:00:00","updated_at":"2026-01-02T00:00:00","base_url":"https://fake-address.example","api_key_env":"FAKE_KEY_VARIABLE","api_key_secret_name":"fake-secret-name","api_key_secret_key":"fake-secret-key","extra_headers":{"X-Fake-Header":"****"},"tls_verify":true,"ca_cert":"fake-certificate","options":{"max_tokens":8000,"tool_result_chars":9000,"temperature":0.2,"api_key":"fake-credential-value"}}`
	modelRowUnused  = `{"id":2,"name":"small","provider":"ollama","model":"tiny-1","enabled":false,"is_default":false,"tier":"economy","used_for":[],"base_url":"https://fake-address.example","api_key_env":null,"options":null}`
	modelRowBadOpts = `{"id":3,"name":"odd","provider":"openai","model":"mid-1","enabled":true,"is_default":false,"tier":"default","used_for":["floating"],"options":{"max_tokens":"fake-credential-value","tool_result_chars":5}}`
	providersRoute  = `{"providers":{"claude-code":{"available":false,"reason":"the image has no Claude Code","fake_field":"fake-credential-value"}}}`
)

func aiModelRoutes(t *testing.T, listStatus int, list string, providerStatus int, providers string) *[]*http.Request {
	t.Helper()
	return fakeAIService(t, func(r *http.Request) (int, string) {
		if r.URL.Path == "/api/v1/ai/model-configs/providers" {
			return providerStatus, providers
		}
		return listStatus, list
	})
}

func TestAIModels_AnswersNameProviderUseAndLimitsAndNoKeyOrAddress(t *testing.T) {
	seen := aiModelRoutes(t, 200, "["+modelRowChat+","+modelRowUnused+","+modelRowBadOpts+"]", 200, providersRoute)
	out := runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})
	for _, held := range []string{"fake-", "FAKE_", "api_key", "base_url", "extra_headers", "ca_cert", "tls_verify", "options", "temperature", "****"} {
		if strings.Contains(out, held) {
			t.Errorf("the answer carries %s: %s", held, out)
		}
	}
	if (*seen)[0].URL.Path != "/api/v1/ai/model-configs" || (*seen)[0].Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s", (*seen)[0].URL)
	}
	m := decode(t, out)
	assertSame(t, "rows", m["rows"], `[`+
		`{"id":1,"name":"main","provider":"anthropic","model":"big-1","enabled":true,"is_default":true,"tier":"default","used_for":["chat","investigation"],"key_env_set":true,"max_tokens":8000,"tool_result_chars":9000},`+
		`{"id":2,"name":"small","provider":"ollama","model":"tiny-1","enabled":false,"is_default":false,"tier":"economy","used_for":[],"key_env_set":null,"max_tokens":null,"tool_result_chars":null},`+
		`{"id":3,"name":"odd","provider":"openai","model":"mid-1","enabled":true,"is_default":false,"tier":"default","used_for":["floating"],"key_env_set":false,"max_tokens":null,"tool_result_chars":null}]`)
	if m["total"] != float64(3) || m["active"] != "main" {
		t.Errorf("total %v, active %v", m["total"], m["active"])
	}
	assertSame(t, "providers", m["providers"], `{"claude-code":{"available":false,"reason":"the image has no Claude Code"}}`)
	for _, said := range []string{"4096", "2048", "6000", "AI Models screen"} {
		if !strings.Contains(textOf(m["note"]), said) {
			t.Errorf("the note should say %s: %v", said, m["note"])
		}
	}
	if strings.Index(out, `"rows":`) < strings.Index(out, `"active":`) {
		t.Errorf("rows before what runs: %.200s", out)
	}
}

// The AI Models card: the variable's name beside a key, "No key env" without one where its provider needs a key, nothing where it does not.
func TestAIModels_KeyEnvSetSaysWhatTheCardSaysAndNeverTheName(t *testing.T) {
	for _, c := range []struct {
		name     string
		provider string
		key      string
		want     interface{}
	}{
		{"a variable named", "openai", `"api_key_env":"FAKE_KEY_VARIABLE"`, true},
		{"a provider that needs no key, with one named", "ollama", `"api_key_env":"FAKE_KEY_VARIABLE"`, true},
		{"none named", "openai", `"api_key_env":null`, false},
		{"an empty name", "openai", `"api_key_env":""`, false},
		{"no such field", "anthropic", `"tier":"default"`, false},
		{"a provider the catalog does not list", "another", `"api_key_env":null`, false},
		// ai-service reads a key through the older field too, and the card says so.
		{"only the older field", "openai", `"api_key_env":null,"api_key_secret_key":"FAKE_KEY_VARIABLE"`, true},
		{"a provider that needs no key", "ollama", `"api_key_env":null`, nil},
		{"the catalog's ids are exact", "Ollama", `"api_key_env":null`, false},
	} {
		aiModelRoutes(t, 200, `[{"id":1,"name":"m","provider":"`+c.provider+`","model":"x","enabled":true,"is_default":false,"tier":"default","used_for":[],`+c.key+`}]`, 200, `{"providers":{}}`)
		out := runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})
		row := firstRow(decode(t, out))
		got, has := row["key_env_set"]
		if !has || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: key_env_set = %v (present %v), want %v", c.name, got, has, c.want)
		}
		if strings.Contains(out, "FAKE_KEY_VARIABLE") {
			t.Errorf("%s: the answer names the variable: %s", c.name, out)
		}
	}
}

var catalogProvider = regexp.MustCompile(`id: '([^']+)',[\s\S]*?needsApiKey: (true|false)`)

// The screen's catalog decides which providers need a key: the tool answers each as the card draws it.
func TestAIModels_EveryProviderOfTheScreensCatalogIsAnsweredAsItsCardIs(t *testing.T) {
	source, err := os.ReadFile("../../frontend/src/constants/modelCatalog.ts")
	if err != nil {
		t.Fatal(err)
	}
	providers := catalogProvider.FindAllStringSubmatch(string(source), -1)
	if len(providers) < 7 {
		t.Fatalf("only %d providers were found: the catalog's shape changed", len(providers))
	}
	for _, provider := range providers {
		aiModelRoutes(t, 200, `[{"id":1,"name":"m","provider":"`+provider[1]+`","model":"x","enabled":true,"is_default":false,"tier":"default","used_for":[],"api_key_env":null}]`, 200, `{"providers":{}}`)
		row := firstRow(decode(t, runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})))
		var want interface{} = false
		if provider[2] == "false" {
			want = nil
		}
		if got, has := row["key_env_set"]; !has || got != want {
			t.Errorf("%s needsApiKey %s: key_env_set = %v (present %v), want %v", provider[1], provider[2], got, has, want)
		}
	}
}

// The limits read as limits.py reads them: what is out of range is empty there and is the call's default.
func TestAIModels_ALimitIsWhatTheModelRunsWith(t *testing.T) {
	for _, c := range []struct {
		options string
		tokens  interface{}
		chars   interface{}
	}{
		{`{"max_tokens":1,"tool_result_chars":1000}`, float64(1), float64(1000)},
		{`{"max_tokens":1000000,"tool_result_chars":200000}`, float64(1000000), float64(200000)},
		{`{"max_tokens":0,"tool_result_chars":999}`, nil, nil},
		{`{"max_tokens":1000001,"tool_result_chars":200001}`, nil, nil},
		{`{"max_tokens":10.5,"tool_result_chars":true}`, nil, nil},
		{`{}`, nil, nil},
	} {
		aiModelRoutes(t, 200, `[{"id":1,"name":"m","provider":"p","model":"x","enabled":true,"is_default":true,"tier":"default","used_for":[],"options":`+c.options+`}]`, 200, `{"providers":{}}`)
		row := firstRow(decode(t, runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})))
		if !reflect.DeepEqual(row["max_tokens"], c.tokens) || !reflect.DeepEqual(row["tool_result_chars"], c.chars) {
			t.Errorf("%s: %v %v", c.options, row["max_tokens"], row["tool_result_chars"])
		}
	}
}

func TestAIModels_NothingRunningIsNotAName(t *testing.T) {
	aiModelRoutes(t, 200, "["+modelRowUnused+"]", 200, `{"providers":{}}`)
	m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{}))
	if got, has := m["active"]; !has || got != nil {
		t.Errorf("active = %v (present %v), want null", got, has)
	}
}

func TestAIModels_ProvidersNotReadLeaveTheRows(t *testing.T) {
	aiModelRoutes(t, 200, "["+modelRowUnused+"]", 500, `{"detail":"boom"}`)
	m := decode(t, runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{}))
	if len(listOf(m["rows"])) != 1 || !strings.Contains(textOf(m["providers_error"]), "boom") {
		t.Errorf("%v", m)
	}
	if _, has := m["providers"]; has {
		t.Errorf("providers not read are not an empty list: %v", m["providers"])
	}
}

func TestAIModels_ARefusalAsksNothingMore(t *testing.T) {
	seen := aiModelRoutes(t, 403, `{"detail":"Permission denied"}`, 200, `{"providers":{}}`)
	out := runTool(t, ctxWithPayload("self", holderOf()), "ai_models", args{})
	if decode(t, out)["status"] != "forbidden" || len(*seen) != 1 {
		t.Errorf("%d requests: %s", len(*seen), out)
	}
}

// windowWithInvestigation is the alert window's answer with an investigation in the given state.
func windowWithInvestigation(status string) string {
	return strings.Replace(inboxOneRoute, `"investigation":null`, `"investigation":{"id":"inv-a","status":"`+status+`"}`, 1)
}

func TestAlertsInbox_WithReportReadsTheReportTheWindowOpens(t *testing.T) {
	seen := fakeAIService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/investigation") {
			return 200, investigationDetail()
		}
		return 200, windowWithInvestigation("done")
	})
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1", "with_report": true})
	if len(*seen) != 2 || (*seen)[1].Method != http.MethodGet || (*seen)[1].URL.Path != "/api/v1/alerts/inbox/a1/investigation" {
		t.Fatalf("%d requests, last %s", len(*seen), (*seen)[len(*seen)-1].URL.Path)
	}
	m := decode(t, out)
	report := mapOf(m["investigation_report"])
	if report["report"] != "The load comes from web-1." || report["status"] != "done" {
		t.Errorf("report: %v", report)
	}
	assertSame(t, "tool calls", report["tool_calls"], `[{"tool":"k8s_get_resources","args":{"resource_type":"pods"},"step":1,"result_chars":120,"access":{"kind":"investigator"}}]`)
	assertNoCredentials(t, "alerts_inbox", out)
	// The marks lead, so a cut at the model's limit keeps them, and the report reads before the labels.
	for _, order := range [][2]string{{`"note":`, `"investigation_report":`}, {`"investigation_report":`, `"annotations":`}} {
		if strings.Index(out, order[0]) > strings.Index(out, order[1]) {
			t.Errorf("%s after %s: %.300s", order[0], order[1], out)
		}
	}
}

func TestAlertsInbox_WithReportReadsNothingWhenThereIsNoReportYet(t *testing.T) {
	for _, status := range []string{"queued", "running"} {
		seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, windowWithInvestigation(status) })
		m := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1", "with_report": true}))
		if len(*seen) != 1 || !strings.Contains(textOf(m["report_error"]), status) {
			t.Errorf("%s: %d requests, %v", status, len(*seen), m["report_error"])
		}
	}
	seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, inboxOneRoute })
	m := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1", "with_report": true}))
	if len(*seen) != 1 || !strings.Contains(textOf(m["report_error"]), "no investigation") {
		t.Errorf("no investigation: %d requests, %v", len(*seen), m["report_error"])
	}
}

func TestAlertsInbox_AReportThatCannotBeReadLeavesTheWindow(t *testing.T) {
	fakeAIService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/investigation") {
			return 503, `{"detail":"audit unavailable"}`
		}
		return 200, windowWithInvestigation("done")
	})
	m := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1", "with_report": true}))
	if !strings.Contains(textOf(m["report_error"]), "audit unavailable") || m["alertname"] == nil {
		t.Errorf("%v", m)
	}
	if _, has := m["investigation_report"]; has {
		t.Errorf("a report not read: %v", m["investigation_report"])
	}
}

func TestClustersList_SaysTheConnectionStatusIsCheckedByItself(t *testing.T) {
	fakeAuthService(t, func(*http.Request) (int, string) { return 200, `{"items":[` + clusterRowSelf + `]}` })
	m := decode(t, runTool(t, ctxWithPayload("self", auth.TokenPayload{Perms: auth.PermissionMatrix{"self": {"ai.tool.*"}}}), "clusters_list", args{}))
	note := textOf(m["note"])
	for _, said := range []string{"every 60 seconds", "multicluster.healthcheckIntervalSec", "last_healthcheck_at"} {
		if !strings.Contains(note, said) {
			t.Errorf("the note should say %q: %s", said, note)
		}
	}
	for _, wrong := range []string{"made at registration or by a person's Test", "not a live probe"} {
		if strings.Contains(note, wrong) {
			t.Errorf("the note says %q: %s", wrong, note)
		}
	}
}

func TestAdminRecords_ArgumentsKeepToTheirShape(t *testing.T) {
	for _, a := range []map[string]interface{}{
		{"investigation_id": "inv-0123456789abcdef"}, {"recording_id": "0f3b0b5e-8a6d-4f7a-9a0f-5d1a2b3c4d5e"},
		{"recording_kind": "exec"}, {"recording_kind": "node-shell"}, {"cluster_id": "prod seoul"}, {"actor_email": "ann@example.com"},
	} {
		if err := validateToolArgs(a); err != nil {
			t.Errorf("%v should pass: %v", a, err)
		}
	}
	for _, a := range []map[string]interface{}{
		{"investigation_id": "../users"}, {"investigation_id": "a/b"}, {"investigation_id": "a%2fb"},
		{"recording_id": "rec/cast"}, {"recording_id": "../rec"}, {"recording_id": "rec?format=text"},
		{"recording_kind": "shell"}, {"cluster_id": "a\nb"}, {"cluster_id": strings.Repeat("x", 129)},
	} {
		if err := validateToolArgs(a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", a, err)
		}
	}
}
