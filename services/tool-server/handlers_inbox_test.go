package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// fakeAIService stands in for ai-service: it records the request and answers as scripted.
func fakeAIService(t *testing.T, respond func(r *http.Request) (int, string)) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		status, body := respond(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	orig := aiServiceURL
	aiServiceURL = srv.URL
	t.Cleanup(func() { aiServiceURL = orig; srv.Close() })
	return &seen
}

// runTool runs a tool as the registry holds it, so a tool that was never registered fails on its name.
func runTool(t *testing.T, ctx context.Context, name string, a map[string]interface{}) string {
	t.Helper()
	tool, ok := buildToolRegistry()[name]
	if !ok {
		t.Fatalf("%s is not a tool", name)
	}
	out, err := tool.Handler(ctx, a, bearer())
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return out
}

func ctxWithPayload(cluster string, payload auth.TokenPayload) context.Context {
	return auth.WithPayload(withClusterID(context.Background(), cluster), payload)
}

func holderOf(perms ...string) auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": perms, "c1": {"ai.tool.*", "resource.alert.investigate", "resource.pod.read"}}}
}

// The fields auth-service answers; the two marked fake stand for what must never leave.
const clusterRowAlpha = `{"id":"alpha","display_name":"Alpha","mode":"external","api_server_url":"https://alpha.example:6443","is_self_cluster":false,
 "prometheus_url":"https://prom.example","prometheus_cluster_label":"alpha","prometheus_auth":true,"prometheus_service":"mon/prom:9090",
 "log_search_url":"https://loki.example","log_search_tenant":"t1","log_search_cluster_label":"alpha","log_search_auth":false,
 "health_status":"unreachable","last_healthcheck_at":"2026-11-06T10:00:00Z","created_by":"ops@example.com","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-11-06T10:00:00Z",
 "kubeconfig":"fake-kubeconfig-value","kubeconfig_secret":"fake-secret-ref"}`

const clusterRowSelf = `{"id":"self","display_name":"Self","mode":"in_cluster","is_self_cluster":true,"prometheus_auth":false,"log_search_auth":false,
 "health_status":"healthy","created_by":"","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`

const clusterRowOther = `{"id":"other","display_name":"Other","mode":"external","api_server_url":"https://other.example:6443","is_self_cluster":false,
 "prometheus_auth":false,"log_search_auth":false,"health_status":"unknown","created_by":"root@example.com","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`

func TestClustersList_AnswersWhatThePickerShowsAndNothingElse(t *testing.T) {
	seen := fakeAuthService(t, func(r *http.Request) (int, string) {
		return 200, `{"items":[` + clusterRowAlpha + `,` + clusterRowSelf + `]}`
	})
	out := runTool(t, ctxWithPayload("self", auth.TokenPayload{Perms: auth.PermissionMatrix{"self": {"ai.tool.*"}, "alpha": {"ai.tool.*"}}}), "clusters_list", args{})

	if len(*seen) != 1 {
		t.Fatalf("%d requests, want the picker's one", len(*seen))
	}
	req := (*seen)[0]
	if req.URL.Path != "/api/v1/clusters" || req.URL.Query().Get("accessibleOnly") != "true" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s?%s auth=%q", req.URL.Path, req.URL.RawQuery, req.Header.Get("Authorization"))
	}
	reply := decode(t, out)
	rows := reply["clusters"].([]interface{})
	want := []map[string]interface{}{
		{"id": "alpha", "display_name": "Alpha", "mode": "external", "is_self_cluster": false, "health_status": "unreachable", "last_healthcheck_at": "2026-11-06T10:00:00Z", "current": false},
		{"id": "self", "display_name": "Self", "mode": "in_cluster", "is_self_cluster": true, "health_status": "healthy", "last_healthcheck_at": nil, "current": true},
	}
	if len(rows) != len(want) || reply["total"] != float64(len(want)) {
		t.Fatalf("rows: %v total %v", rows, reply["total"])
	}
	for i, w := range want {
		if !reflect.DeepEqual(rows[i], w) {
			t.Errorf("row %d: got %v, want %v", i, rows[i], w)
		}
	}
	for _, leak := range []string{"fake-kubeconfig-value", "fake-secret-ref", "kubeconfig", "https://alpha.example", "https://prom.example", "https://loki.example", "ops@example.com"} {
		if strings.Contains(out, leak) {
			t.Errorf("the answer of someone without the cluster list holds %q: %s", leak, out)
		}
	}
}

func TestClustersList_AHolderOfTheClusterListGetsTheAdminScreensRows(t *testing.T) {
	seen := fakeAuthService(t, func(r *http.Request) (int, string) {
		if r.URL.Query().Get("accessibleOnly") == "true" {
			return 200, `{"items":[` + clusterRowAlpha + `]}`
		}
		return 200, `{"items":[` + clusterRowAlpha + `,` + clusterRowOther + `]}`
	})
	out := runTool(t, ctxWithPayload("alpha", holderOf(auth.PermClustersList)), "clusters_list", args{})
	if len(*seen) != 2 {
		t.Fatalf("%d requests, want the registry and what the holder reaches", len(*seen))
	}
	rows := decode(t, out)["clusters"].([]interface{})
	if len(rows) != 2 {
		t.Fatalf("rows: %v", rows)
	}
	alpha, other := rows[0].(map[string]interface{}), rows[1].(map[string]interface{})
	if alpha["reachable"] != true || other["reachable"] != false {
		t.Errorf("reachable: alpha %v, other %v, want what the picker's answer holds", alpha["reachable"], other["reachable"])
	}
	for field, value := range map[string]interface{}{
		"api_server_url": "https://alpha.example:6443", "created_by": "ops@example.com", "prometheus_url": "https://prom.example",
		"prometheus_cluster_label": "alpha", "prometheus_auth": true, "prometheus_service": "mon/prom:9090",
		"log_search_url": "https://loki.example", "log_search_tenant": "t1", "log_search_cluster_label": "alpha", "log_search_auth": false,
	} {
		if alpha[field] != value {
			t.Errorf("%s: got %v, want %v", field, alpha[field], value)
		}
	}
	for _, leak := range []string{"fake-kubeconfig-value", "fake-secret-ref", "kubeconfig"} {
		if strings.Contains(out, leak) {
			t.Errorf("the answer holds %q: %s", leak, out)
		}
	}
}

// What leaves for the model goes through the masking: the rows stay what the screen shows, and a password in an address does not stay.
func TestClustersList_TheMaskingKeepsTheRowsAndTakesAPasswordInAnAddress(t *testing.T) {
	withPassword := strings.Replace(clusterRowOther, `"api_server_url":"https://other.example:6443"`, `"api_server_url":"https://u:fake-url-password@other.example:6443"`, 1)
	fakeAuthService(t, func(r *http.Request) (int, string) {
		if r.URL.Query().Get("accessibleOnly") == "true" {
			return 200, `{"items":[` + clusterRowAlpha + `]}`
		}
		return 200, `{"items":[` + clusterRowAlpha + `,` + withPassword + `]}`
	})
	out := runTool(t, ctxWithPayload("alpha", holderOf(auth.PermClustersList)), "clusters_list", args{})
	masked, _ := redactToolOutput(out)
	if strings.Contains(masked, "fake-url-password") {
		t.Errorf("a password in an address left for the model: %s", masked)
	}
	before, after := decode(t, out)["clusters"].([]interface{})[0], decode(t, masked)["clusters"].([]interface{})[0]
	if !reflect.DeepEqual(before, after) {
		t.Errorf("the masking changed a row without a secret:\nbefore %v\nafter  %v", before, after)
	}
}

func TestClustersList_SaysWhichNamespacesAGrantIsLimitedTo(t *testing.T) {
	fakeAuthService(t, func(r *http.Request) (int, string) { return 200, `{"items":[` + clusterRowAlpha + `]}` })
	payload := auth.TokenPayload{Perms: auth.PermissionMatrix{"alpha": {"ai.tool.*"}}, Namespaces: map[string][]string{"alpha": {"api", "web"}}}
	row := decode(t, runTool(t, ctxWithPayload("alpha", payload), "clusters_list", args{}))["clusters"].([]interface{})[0].(map[string]interface{})
	if !reflect.DeepEqual(row["namespaces"], []interface{}{"api", "web"}) {
		t.Fatalf("namespaces: %v", row["namespaces"])
	}
	if err := namespaceGate(payload, "alpha", "clusters_list", args{}); err != nil {
		t.Fatalf("the picker works for a limited grant, the tool must too: %v", err)
	}
}

func TestClustersList_NoClusterAndARefusal(t *testing.T) {
	fakeAuthService(t, func(r *http.Request) (int, string) { return 200, `{"items":[]}` })
	reply := decode(t, runTool(t, ctxFor("self"), "clusters_list", args{}))
	if rows, ok := reply["clusters"].([]interface{}); !ok || len(rows) != 0 || reply["total"] != float64(0) {
		t.Fatalf("an empty registry is an empty list: %v", reply)
	}
	fakeAuthService(t, func(r *http.Request) (int, string) {
		return 403, `{"detail":"forbidden: requires admin.clusters.list"}`
	})
	if got := decode(t, runTool(t, ctxFor("self"), "clusters_list", args{})); got["status"] != "forbidden" {
		t.Fatalf("refused: %v", got)
	}
}

// One alert window as ai-service answers it; the fields the tool repeats must stay the server's values.
func inboxWindow(id, cluster, invID, invStatus string, started *bool) string {
	inv := "null"
	if invID != "" {
		inv = `{"id":"` + invID + `","status":"` + invStatus + `","skip_reason":"","skip_reason_key":"","skip_reason_args":{},"requested_by":"ops@example.com","received_at":"2026-11-06T10:00:00Z"}`
	}
	tail := ""
	if started != nil {
		tail = `,"started":` + strconv.FormatBool(*started)
	}
	return `{"id":"` + id + `","cluster":"` + cluster + `","fingerprint":"f1","alertname":"KubePodCrashLooping","severity":"critical","namespace":"shop",
 "labels":{"alertname":"KubePodCrashLooping","namespace":"shop","pod":"web-1"},"summary":"web-1 restarts","status":"firing","starts_at":"2026-11-06T09:00:00Z","resolved_at":null,
 "last_received_at":"2026-11-06T10:00:00Z","received_count":3,"acknowledged":false,"assignee":"","done":false,"annotations":{"summary":"web-1 restarts"},"note":"",
 "investigation":` + inv + `,"investigate_now":{"permission":"resource.alert.investigate","allowed":false,"reason":"investigating","until":null,"automatic":true,"budget":200000,"used":60029}` + tail + `}`
}

func TestAlertInvestigate_StartsOnTheButtonsRouteAndRepeatsItsAnswer(t *testing.T) {
	yes := true
	seen := fakeAIService(t, func(r *http.Request) (int, string) {
		if r.Method == http.MethodPost {
			return 200, inboxWindow("a1", "c1", "inv-1", "queued", &yes)
		}
		return 200, inboxWindow("a1", "c1", "", "", nil)
	})
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"})

	var posts []*http.Request
	for _, r := range *seen {
		if r.Method == http.MethodPost {
			posts = append(posts, r)
		}
	}
	if len(posts) != 1 || posts[0].URL.Path != "/api/v1/alerts/inbox/a1/investigate" || posts[0].Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("the press: %d posts %v", len(posts), *seen)
	}
	reply := decode(t, out)
	if reply["started"] != true {
		t.Errorf("started: %v", reply["started"])
	}
	var window map[string]interface{}
	if err := json.Unmarshal([]byte(inboxWindow("a1", "c1", "inv-1", "queued", &yes)), &window); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"investigation", "investigate_now"} {
		if !reflect.DeepEqual(reply[field], window[field]) {
			t.Errorf("%s: got %v, want the window's %v", field, reply[field], window[field])
		}
	}
	alert := reply["alert"].(map[string]interface{})
	for _, field := range []string{"id", "alertname", "severity", "namespace", "status", "summary", "starts_at", "labels", "cluster"} {
		if !reflect.DeepEqual(alert[field], window[field]) {
			t.Errorf("alert.%s: got %v, want the window's %v", field, alert[field], window[field])
		}
	}
	if reply["report"] != nil {
		t.Errorf("a queued investigation has no report yet: %v", reply["report"])
	}
	if want := "/alerts?alert=a1&cluster=c1"; reply["alert_link"] != want || reply["report_link"] != want {
		t.Errorf("links for someone without the admin screen: %v %v, want %s", reply["alert_link"], reply["report_link"], want)
	}
}

func TestAlertInvestigate_TheMaskingKeepsTheAnswerAndTakesASecretInAReport(t *testing.T) {
	no := false
	fakeAIService(t, func(r *http.Request) (int, string) {
		switch {
		case r.Method == http.MethodPost:
			return 200, inboxWindow("a1", "c1", "inv-1", "done", &no)
		case strings.HasSuffix(r.URL.Path, "/investigation"):
			return 200, strings.Replace(finishedInvestigation, "%REPORT%", `The log says:\npassword: fake-report-password\nand stops.`, 1)
		}
		return 200, inboxWindow("a1", "c1", "inv-1", "done", nil)
	})
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"})
	masked, _ := redactToolOutput(out)
	if strings.Contains(masked, "fake-report-password") {
		t.Errorf("a secret in a report left for the model: %s", masked)
	}
	plain, kept := decode(t, out), decode(t, masked)
	for _, field := range []string{"investigate_now", "investigation", "alert", "report_link", "alert_link", "started", "total_tokens", "model"} {
		if !reflect.DeepEqual(plain[field], kept[field]) {
			t.Errorf("the masking changed %s:\nbefore %v\nafter  %v", field, plain[field], kept[field])
		}
	}
}

func TestAlertInvestigate_TheReportLinkOpensAScreenTheUserHas(t *testing.T) {
	no := false
	fakeAIService(t, func(r *http.Request) (int, string) {
		if r.Method == http.MethodPost {
			return 200, inboxWindow("a1", "c1", "inv-1", "running", &no)
		}
		return 200, inboxWindow("a1", "c1", "inv-1", "running", nil)
	})
	reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf("admin.investigations.read")), "alert_investigate", args{"alert_id": "a1"}))
	if reply["report_link"] != "/admin/investigations?id=inv-1" {
		t.Errorf("report_link: %v", reply["report_link"])
	}
	if reply["started"] != false {
		t.Errorf("started: %v", reply["started"])
	}
	cases := map[string]string{"https://kubeast.example/admin/investigations?id=inv-1": "report_link", "https://kubeast.example/alerts?alert=a1&cluster=c1": "alert_link"}
	orig := consoleURL
	consoleURL = "https://kubeast.example"
	t.Cleanup(func() { consoleURL = orig })
	reply = decode(t, runTool(t, ctxWithPayload("c1", holderOf("admin.investigations.read")), "alert_investigate", args{"alert_id": "a1"}))
	for want, field := range cases {
		if reply[field] != want {
			t.Errorf("%s with a console address: %v, want %s", field, reply[field], want)
		}
	}
}

func TestAlertInvestigate_AnAlertOfAnotherClusterIsNotPressed(t *testing.T) {
	seen := fakeAIService(t, func(r *http.Request) (int, string) { return 200, inboxWindow("a1", "prod", "", "", nil) })
	reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"}))
	if reply["status"] != "not_found" {
		t.Errorf("status: %v", reply["status"])
	}
	for _, r := range *seen {
		if r.Method == http.MethodPost {
			t.Fatalf("pressed an alert of another cluster: %s", r.URL.Path)
		}
	}
}

func inboxRow(id, name, namespace, status string, labels string) string {
	return `{"id":"` + id + `","cluster":"c1","fingerprint":"f-` + id + `","alertname":"` + name + `","severity":"warning","namespace":"` + namespace + `","labels":` + labels + `,"summary":"s","status":"` + status + `","starts_at":"2026-11-06T09:00:00Z","investigation":null}`
}

func inboxList(total int, rows ...string) string {
	return `{"items":[` + strings.Join(rows, ",") + `],"total":` + strconv.Itoa(total) + `,"counts":{},"limit":200,"offset":0}`
}

func TestAlertInvestigate_FindsTheAlertByNameAmongTheInboxRows(t *testing.T) {
	yes := true
	for _, c := range []struct {
		name   string
		args   args
		rows   []string
		wantID string // "" = nothing pressed
		status string
		many   int
	}{
		{"one exact name, a longer name beside it", args{"alertname": "HighLoad"},
			[]string{inboxRow("a1", "HighLoad", "shop", "firing", `{}`), inboxRow("a2", "HighLoadSpike", "shop", "firing", `{}`)}, "a1", "", 0},
		{"a firing row wins over resolved ones", args{"alertname": "HighLoad"},
			[]string{inboxRow("a1", "HighLoad", "shop", "firing", `{}`), inboxRow("a2", "HighLoad", "shop", "resolved", `{}`)}, "a1", "", 0},
		{"a stale row is still open", args{"alertname": "HighLoad"},
			[]string{inboxRow("a1", "HighLoad", "shop", "stale", `{}`), inboxRow("a2", "HighLoad", "shop", "resolved", `{}`)}, "a1", "", 0},
		{"only a resolved one", args{"alertname": "HighLoad"},
			[]string{inboxRow("a2", "HighLoad", "shop", "resolved", `{}`)}, "a2", "", 0},
		{"the namespace narrows", args{"alertname": "HighLoad", "namespace": "web"},
			[]string{inboxRow("a1", "HighLoad", "shop", "firing", `{}`), inboxRow("a2", "HighLoad", "web", "firing", `{}`)}, "a2", "", 0},
		{"the labels narrow", args{"alertname": "HighLoad", "alert_labels": map[string]interface{}{"pod": "web-2"}},
			[]string{inboxRow("a1", "HighLoad", "shop", "firing", `{"pod":"web-1"}`), inboxRow("a2", "HighLoad", "shop", "firing", `{"pod":"web-2"}`)}, "a2", "", 0},
		{"two open ones are asked about", args{"alertname": "HighLoad"},
			[]string{inboxRow("a1", "HighLoad", "shop", "firing", `{}`), inboxRow("a2", "HighLoad", "web", "firing", `{}`)}, "", "ambiguous", 2},
		{"none", args{"alertname": "HighLoad"},
			[]string{inboxRow("a2", "HighLoadSpike", "shop", "firing", `{}`)}, "", "not_found", 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			seen := fakeAIService(t, func(r *http.Request) (int, string) {
				switch {
				case r.Method == http.MethodPost:
					return 200, inboxWindow(strings.Split(r.URL.Path, "/")[5], "c1", "inv-1", "queued", &yes)
				case r.URL.Path == "/api/v1/alerts/inbox":
					return 200, inboxList(len(c.rows), c.rows...)
				}
				return 200, inboxWindow(strings.Split(r.URL.Path, "/")[5], "c1", "", "", nil)
			})
			reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", c.args))
			first := (*seen)[0]
			if first.URL.Path != "/api/v1/alerts/inbox" || first.URL.Query().Get("cluster") != "c1" || first.URL.Query().Get("q") != "HighLoad" {
				t.Fatalf("list request: %s?%s", first.URL.Path, first.URL.RawQuery)
			}
			var pressed string
			for _, r := range *seen {
				if r.Method == http.MethodPost {
					pressed = strings.Split(r.URL.Path, "/")[5]
				}
			}
			if pressed != c.wantID {
				t.Errorf("pressed %q, want %q (%v)", pressed, c.wantID, reply)
			}
			if c.status != "" && reply["status"] != c.status {
				t.Errorf("status %v, want %s (%v)", reply["status"], c.status, reply)
			}
			if c.many > 0 {
				found, _ := reply["alerts"].([]interface{})
				if len(found) != c.many || reply["total"] != float64(c.many) {
					t.Errorf("candidates: %v total %v, want %d", found, reply["total"], c.many)
				}
				for _, one := range found {
					if m := one.(map[string]interface{}); m["id"] == "" || m["id"] == nil {
						t.Errorf("a candidate without its id: %v", m)
					}
				}
			}
		})
	}
}

func TestAlertInvestigate_ReadsTheInboxToItsEndBeforeItDecides(t *testing.T) {
	var offsets []string
	yes := true
	seen := fakeAIService(t, func(r *http.Request) (int, string) {
		switch {
		case r.Method == http.MethodPost:
			return 200, inboxWindow("a2", "c1", "inv-1", "queued", &yes)
		case r.URL.Path != "/api/v1/alerts/inbox":
			return 200, inboxWindow("a2", "c1", "", "", nil)
		}
		offsets = append(offsets, r.URL.Query().Get("offset"))
		if r.URL.Query().Get("offset") == "0" {
			rows := []string{inboxRow("a1", "HighLoad", "shop", "resolved", `{}`)}
			for i := 0; i < inboxPageSize-1; i++ {
				rows = append(rows, inboxRow("o"+strconv.Itoa(i), "HighLoadOther", "shop", "firing", `{}`))
			}
			return 200, inboxList(inboxPageSize+1, rows...)
		}
		return 200, inboxList(inboxPageSize+1, inboxRow("a2", "HighLoad", "shop", "firing", `{}`))
	})
	runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alertname": "HighLoad"})
	if !reflect.DeepEqual(offsets, []string{"0", strconv.Itoa(inboxPageSize)}) {
		t.Fatalf("offsets read: %v", offsets)
	}
	for _, r := range *seen {
		if r.Method == http.MethodPost && !strings.Contains(r.URL.Path, "/a2/") {
			t.Fatalf("pressed %s, the open row was on the next page", r.URL.Path)
		}
	}
}

func TestAlertInvestigate_ARefusalKeepsTheServersWordsAndNumbers(t *testing.T) {
	until := "2026-11-07T00:00:00Z"
	for _, c := range []struct {
		name, body, wantStatus, wantCode string
		code                             int
		wantUntil                        interface{}
		wantBudget, wantUsed             interface{}
	}{
		{"no permission", `{"detail":{"code":"forbidden","message":"permission required: resource.alert.investigate","until":null,"budget":200000,"used":0}}`, "forbidden", "forbidden", 403, nil, float64(200000), float64(0)},
		{"switched off", `{"detail":{"code":"manual_off","message":"manual investigations are off (features.alertInvestigation.manual)","until":null,"budget":0,"used":0}}`, "forbidden", "manual_off", 403, nil, float64(0), float64(0)},
		{"budget spent", `{"detail":{"code":"manual_budget","message":"the daily token budget of manual investigations is spent (UTC day)","until":"` + until + `","budget":200000,"used":200431}}`, "rate_limited", "manual_budget", 429, until, float64(200000), float64(200431)},
		{"provider pause", `{"detail":{"code":"provider_paused","message":"the AI model provider refused an investigation; none runs until the pause ends","until":"` + until + `","budget":0,"used":0}}`, "rate_limited", "provider_paused", 429, until, float64(0), float64(0)},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeAIService(t, func(r *http.Request) (int, string) {
				if r.Method == http.MethodPost {
					return c.code, c.body
				}
				return 200, inboxWindow("a1", "c1", "", "", nil)
			})
			reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"}))
			if reply["status"] != c.wantStatus || reply["code"] != c.wantCode || reply["until"] != c.wantUntil || reply["budget"] != c.wantBudget || reply["used"] != c.wantUsed {
				t.Errorf("got %v", reply)
			}
			var parsed struct {
				Detail struct {
					Message string `json:"message"`
				} `json:"detail"`
			}
			if err := json.Unmarshal([]byte(c.body), &parsed); err != nil {
				t.Fatal(err)
			}
			if reply["reason"] != parsed.Detail.Message {
				t.Errorf("reason %v, want the server's %q", reply["reason"], parsed.Detail.Message)
			}
			if hint, _ := reply["hint"].(string); strings.Contains(hint, "Too many calls") {
				t.Errorf("a day's budget or a pause is not a rate of calls: %s", hint)
			}
		})
	}
}

func TestAlertInvestigate_TheOtherAnswersOfTheRoute(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"the inbox is off", 404, `{"detail":"the alert inbox is off (features.alertInvestigation.enabled)"}`, "unavailable"},
		{"missing or not this reader's", 404, `{"detail":"alert not found"}`, "not_found"},
		{"no audit row, nothing queued", 503, `{"detail":"audit unavailable"}`, "audit_unavailable"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeAIService(t, func(r *http.Request) (int, string) { return c.status, c.body })
			reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"}))
			if reply["status"] != c.want {
				t.Errorf("status %v, want %s (%v)", reply["status"], c.want, reply)
			}
		})
	}
}

const finishedInvestigation = `{"id":"inv-1","status":"done","report":"%REPORT%","error":"","model":"m1","provider":"p1","total_tokens":60029,"iterations":4,"tool_call_count":7,"duration_ms":81000,"finished_at":"2026-11-06T10:02:00Z","requested_by":"ops@example.com"}`

func TestAlertInvestigate_ADoneInvestigationAnswersItsReportAndStartsNothing(t *testing.T) {
	no := false
	report := "## Cause\nThe pod runs out of memory."
	seen := fakeAIService(t, func(r *http.Request) (int, string) {
		switch {
		case r.Method == http.MethodPost:
			return 200, inboxWindow("a1", "c1", "inv-1", "done", &no)
		case strings.HasSuffix(r.URL.Path, "/investigation"):
			return 200, strings.Replace(finishedInvestigation, "%REPORT%", strings.ReplaceAll(report, "\n", `\n`), 1)
		}
		return 200, inboxWindow("a1", "c1", "inv-1", "done", nil)
	})
	reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"}))
	if reply["started"] != false || reply["report"] != report || reply["report_truncated"] != false {
		t.Fatalf("got %v", reply)
	}
	if reply["total_tokens"] != float64(60029) || reply["model"] != "m1" || reply["tool_call_count"] != float64(7) || reply["duration_ms"] != float64(81000) || reply["finished_at"] != "2026-11-06T10:02:00Z" {
		t.Errorf("the report's numbers: %v", reply)
	}
	read := false
	for _, r := range *seen {
		read = read || (r.Method == http.MethodGet && r.URL.Path == "/api/v1/alerts/inbox/a1/investigation")
	}
	if !read {
		t.Errorf("the report is read through the route that records its view: %v", *seen)
	}
}

func TestAlertInvestigate_ALongReportIsCutAndSaysSo(t *testing.T) {
	no := false
	report := strings.Repeat("가", investigationReportCap) + strings.Repeat("나", 5)
	fakeAIService(t, func(r *http.Request) (int, string) {
		switch {
		case r.Method == http.MethodPost:
			return 200, inboxWindow("a1", "c1", "inv-1", "done", &no)
		case strings.HasSuffix(r.URL.Path, "/investigation"):
			return 200, strings.Replace(finishedInvestigation, "%REPORT%", report, 1)
		}
		return 200, inboxWindow("a1", "c1", "inv-1", "done", nil)
	})
	reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1"}))
	if reply["report"] != strings.Repeat("가", investigationReportCap) || reply["report_truncated"] != true || reply["report_chars"] != float64(investigationReportCap+5) {
		t.Fatalf("cut: truncated=%v chars=%v len=%d", reply["report_truncated"], reply["report_chars"], len([]rune(reply["report"].(string))))
	}
}

func TestAlertInvestigate_TheStatusOnlyCallStartsNothing(t *testing.T) {
	for _, c := range []struct {
		name, invStatus string
		wantRead        bool
	}{
		{"failed: a press would start a new one", "failed", true},
		{"skipped: a press would start a new one", "skipped", false},
		{"queued", "queued", false},
		{"done", "done", true},
		{"never investigated", "", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			invID := "inv-1"
			if c.invStatus == "" {
				invID = ""
			}
			seen := fakeAIService(t, func(r *http.Request) (int, string) {
				if strings.HasSuffix(r.URL.Path, "/investigation") {
					return 200, `{"id":"inv-1","status":"` + c.invStatus + `","report":"","error":"investigator token refused by auth-service (400)","finished_at":"2026-11-06T10:02:00Z"}`
				}
				return 200, inboxWindow("a1", "c1", invID, c.invStatus, nil)
			})
			reply := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alert_investigate", args{"alert_id": "a1", "status_only": true}))
			read := false
			for _, r := range *seen {
				if r.Method == http.MethodPost {
					t.Fatalf("status_only pressed: %s", r.URL.Path)
				}
				read = read || strings.HasSuffix(r.URL.Path, "/investigation")
			}
			if read != c.wantRead {
				t.Errorf("read the report: %v, want %v", read, c.wantRead)
			}
			if reply["started"] != false {
				t.Errorf("started: %v", reply["started"])
			}
			if c.invStatus == "failed" && reply["error"] != "investigator token refused by auth-service (400)" {
				t.Errorf("why it failed: %v", reply["error"])
			}
			if c.invStatus == "" && reply["investigation"] != nil {
				t.Errorf("investigation: %v", reply["investigation"])
			}
			if c.invStatus == "" && reply["report_link"] != nil {
				t.Errorf("no investigation, no report link: %v", reply["report_link"])
			}
		})
	}
}

func TestAlertInvestigate_NeedsAnAlertAndAnIDThatStaysInItsPath(t *testing.T) {
	seen := fakeAIService(t, func(r *http.Request) (int, string) { return 200, `{}` })
	tool, ok := buildToolRegistry()["alert_investigate"]
	if !ok {
		t.Fatal("alert_investigate is not a tool")
	}
	if _, err := tool.Handler(ctxWithPayload("c1", holderOf()), args{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Errorf("no alert named: %v", err)
	}
	if len(*seen) != 0 {
		t.Errorf("asked ai-service: %v", *seen)
	}
	for _, id := range []string{"../../ai/mcp", "a/b", "a b", "a?x=1", "-a", strings.Repeat("a", 129)} {
		if err := validateToolArgs(args{"alert_id": id}); err == nil {
			t.Errorf("alert_id %q passed the argument check", id)
		}
	}
	for _, id := range []string{"7f3b2c1e-9a4d-4b1e-8c2f-1d2e3f4a5b6c", "a1"} {
		if err := validateToolArgs(args{"alert_id": id}); err != nil {
			t.Errorf("alert_id %q refused: %v", id, err)
		}
	}
}

func TestAlertInvestigate_AsksWhatTheButtonAsks(t *testing.T) {
	investigator := []string{"ai.tool.alert_investigate", "resource.alert.investigate", "resource.pod.read"}
	for _, c := range []struct {
		name   string
		perms  auth.PermissionMatrix
		status int
	}{
		{"the permissions of the button and the tool", auth.PermissionMatrix{"c1": investigator}, 0},
		{"global admin", auth.PermissionMatrix{"*": {"*"}}, 0},
		{"the seeded Write role, without the button's permission", auth.PermissionMatrix{"c1": writeRolePerms}, http.StatusForbidden},
		{"the seeded Read role", auth.PermissionMatrix{"c1": readRolePerms()}, http.StatusForbidden},
		{"the button's permission without reading the pods", auth.PermissionMatrix{"c1": {"ai.tool.alert_investigate", "resource.alert.investigate"}}, http.StatusForbidden},
		{"the button's permissions without the tool", auth.PermissionMatrix{"c1": {"ai.tool.can_i", "resource.alert.investigate", "resource.pod.read"}}, http.StatusForbidden},
		{"the permissions on another cluster", auth.PermissionMatrix{"c2": investigator}, http.StatusForbidden},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, status, _ := authorizeToolCall(fakeValidator{payload: auth.TokenPayload{Perms: c.perms}}, hdr("t"), "alert_investigate", "c1", args{"alert_id": "a1"})
			if status != c.status {
				t.Errorf("status %d, want %d", status, c.status)
			}
		})
	}
	if _, listed := toolAppPermissions("alert_investigate", args{}); !listed {
		t.Error("alert_investigate is not in the table")
	}
	if _, listed := toolAppPermissions("clusters_list", args{}); !listed {
		t.Error("clusters_list is not in the table")
	}
}

// The screen's window answers 404 to a grant limited to namespaces: the tool says why instead.
func TestAlertInvestigate_ANamespaceLimitedGrantIsRefused(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c1": {"*"}}, Namespaces: map[string][]string{"c1": {"shop"}}}
	if err := namespaceGate(scoped, "c1", "alert_investigate", args{"alert_id": "a1", "namespace": "shop"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("got %v", err)
	}
}

// No approval card: the button starts it without a confirmation and the cluster does not change.
func TestAlertInvestigate_IsNotACallThatWaitsForAnApproval(t *testing.T) {
	if requiresApproval("alert_investigate") {
		t.Fatal("it does not change the cluster, as a write tool does")
	}
}

// The screen shows the upgrade target and every check; the tool's answer holds the same, past the cap too.
func TestHygiene_TheUpgradeChecksComeThrough(t *testing.T) {
	findings := []string{}
	for i := 0; i < hygieneFindCap+5; i++ {
		findings = append(findings, `{"check":"pss-level","severity":"critical","kind":"Namespace","name":"ns`+strconv.Itoa(i)+`","message":"m"}`)
	}
	findings = append(findings,
		`{"check":"upgrade.node.skew","severity":"warning","kind":"Node","name":"n1","message":"kubelet v1.33 is 3 minors behind"}`,
		`{"check":"upgrade.removed-api.helm","severity":"critical","kind":"Ingress","namespace":"shop","name":"web/in","message":"removed in v1.37"}`,
	)
	body := `{"cluster":"c1","interval_days":90,"last_review":null,"next_due":null,"due":true,"report":{"generated_at":"t","server_version":"v1.36.2","target_version":"v1.37","counts":{"critical":204,"warning":1},
 "checks":[{"id":"pss-level","severity":"critical","count":205,"applies":true},{"id":"upgrade.node.skew","severity":"warning","count":1,"applies":true},{"id":"upgrade.removed-api.helm","severity":"critical","count":1,"applies":true},{"id":"upgrade.pod.git-repo","severity":"warning","count":0,"applies":true,"since":36}],
 "findings":[` + strings.Join(findings, ",") + `]}}`
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })

	report := decode(t, runTool(t, ctxFor("c1"), "hygiene", args{}))["report"].(map[string]interface{})
	if report["server_version"] != "v1.36.2" || report["target_version"] != "v1.37" {
		t.Errorf("versions: %v %v", report["server_version"], report["target_version"])
	}
	var upgradeChecks []string
	for _, c := range report["checks"].([]interface{}) {
		if id := c.(map[string]interface{})["id"].(string); strings.HasPrefix(id, "upgrade.") {
			upgradeChecks = append(upgradeChecks, id)
		}
	}
	if want := []string{"upgrade.node.skew", "upgrade.removed-api.helm", "upgrade.pod.git-repo"}; !reflect.DeepEqual(upgradeChecks, want) {
		t.Errorf("upgrade checks past the findings' cap: %v, want %v", upgradeChecks, want)
	}
	if report["findings_total"] != float64(hygieneFindCap+7) || report["truncated"] != true {
		t.Errorf("the cut says so: %v %v", report["findings_total"], report["truncated"])
	}

	filtered := decode(t, runTool(t, ctxFor("c1"), "hygiene", args{"check": "upgrade.node.skew"}))["report"].(map[string]interface{})
	found := filtered["findings"].([]interface{})
	if len(found) != 1 || found[0].(map[string]interface{})["name"] != "n1" || found[0].(map[string]interface{})["message"] != "kubelet v1.33 is 3 minors behind" {
		t.Errorf("one check's findings: %v", found)
	}
	if filtered["truncated"] == true {
		t.Errorf("one check's few findings are not cut: %v", filtered["truncated"])
	}
}
