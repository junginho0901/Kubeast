package main

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestAlertsList_AsksTheStoreAndCuts(t *testing.T) {
	alerts := make([]string, 60)
	for i := range alerts {
		alerts[i] = fmt.Sprintf(`{"fingerprint":"f%d","alertname":"A","state":"firing"}`, i)
	}
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"alerts":[` + strings.Join(alerts, ",") + `],"total":60,"states":{"firing":60},"byName":[{"alertname":"A","count":60}],"silences":[]}`
	})
	out, err := handleAlertsList(ctxFor("c1"), map[string]interface{}{"alertname": "A", "alert_labels": map[string]interface{}{"severity": "critical", "namespace": "shop"}}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	r := (*seen)[0]
	q := r.URL.Query()
	if r.URL.Path != "/api/v1/alertstore/alerts" || q.Get("state") != "firing" || q.Get("alertname") != "A" || strings.Join(q["label"], " ") != "namespace=shop severity=critical" ||
		q.Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	if m["returned"] != float64(alertsCap) || m["total"] != float64(60) || m["truncated"] != true || !strings.Contains(m["note"].(string), "50 of 60") {
		t.Fatalf("result: %s", out)
	}
}

const silencesRoute = `{"silences":[` +
	`{"id":"s1","state":"active","matchers":["team=\"a\""],"createdBy":"ann@example.com","comment":"upgrade","startsAt":"2026-11-07T00:00:00Z","endsAt":"2026-11-07T02:00:00Z","scope":"cluster"},` +
	`{"id":"s2","state":"pending","matchers":["alertname=\"X\""],"createdBy":"bob@example.com","startsAt":"2026-11-08T00:00:00Z","endsAt":"2026-11-08T02:00:00Z","scope":"all"},` +
	`{"id":"s3","state":"active","matchers":["cluster=~\"c.*\""],"startsAt":"2026-11-07T00:00:00Z","endsAt":"2026-11-09T00:00:00Z","scope":"pattern"}]}`

func TestAlertsList_SilencesAnswersTheSilencesTab(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, silencesRoute })
	out, err := handleAlertsList(ctxFor("c1"), args{"silences": true, "state": "all", "alertname": "ignored"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 {
		t.Fatalf("%d calls", len(*seen))
	}
	r := (*seen)[0]
	if r.URL.Path != "/api/v1/alertstore/silences" || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", r.URL.Path, r.URL.RawQuery)
	}
	m := decode(t, out)
	assertSame(t, "silences", m["silences"], silencesRoute[len(`{"silences":`):len(silencesRoute)-1])
	for key, want := range map[string]interface{}{"total": float64(3), "returned": float64(3), "this_cluster": float64(1), "other_scopes": float64(2)} {
		if m[key] != want {
			t.Errorf("%s = %v, want %v", key, m[key], want)
		}
	}
	if _, has := m["alerts"]; has {
		t.Errorf("the tab lists no alerts: %s", out)
	}
	if _, has := m["truncated"]; has {
		t.Errorf("not cut: %s", out)
	}
}

// The tab reads a silence without a scope as this cluster's.
func TestAlertsList_ASilenceWithoutAScopeIsThisClusters(t *testing.T) {
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"silences":[{"id":"s1","state":"active","matchers":[],"startsAt":"2026-11-07T00:00:00Z","endsAt":"2026-11-07T02:00:00Z"}]}`
	})
	out, err := handleAlertsList(ctxFor("c1"), args{"silences": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["this_cluster"] != float64(1) || m["other_scopes"] != float64(0) {
		t.Errorf("%s", out)
	}
}

func TestAlertsList_NoSilenceSaysSo(t *testing.T) {
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"silences":[]}` })
	out, err := handleAlertsList(ctxFor("c1"), args{"silences": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["total"] != float64(0) || !reflect.DeepEqual(m["silences"], []interface{}{}) || !strings.Contains(fmt.Sprint(m["hint"]), "No silence") {
		t.Errorf("%s", out)
	}
}

func TestAlertsList_ALongSilenceListSaysItWasCutAndCountsThemAll(t *testing.T) {
	rows := make([]string, silencesCap+5)
	for i := range rows {
		scope := "cluster"
		if i < 3 || i >= silencesCap+1 {
			scope = "all"
		}
		rows[i] = fmt.Sprintf(`{"id":"s%d","state":"active","matchers":[],"scope":%q}`, i, scope)
	}
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"silences":[` + strings.Join(rows, ",") + `]}` })
	out, err := handleAlertsList(ctxFor("c1"), args{"silences": true}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if m["total"] != float64(silencesCap+5) || m["returned"] != float64(silencesCap) || m["truncated"] != true {
		t.Errorf("head: total %v returned %v truncated %v", m["total"], m["returned"], m["truncated"])
	}
	if m["this_cluster"] != float64(silencesCap-2) || m["other_scopes"] != float64(7) {
		t.Errorf("counts: %v %v", m["this_cluster"], m["other_scopes"])
	}
	if !strings.Contains(fmt.Sprint(m["note"]), fmt.Sprintf("%d of %d", silencesCap, silencesCap+5)) {
		t.Errorf("note: %v", m["note"])
	}
	if got := len(m["silences"].([]interface{})); got != silencesCap {
		t.Errorf("%d rows", got)
	}
}

func TestAlertsList_SilencesKeepsTheRefusalsOfTheAlerts(t *testing.T) {
	for _, c := range []struct {
		status int
		detail string
		want   string
	}{
		{404, "alert store is not configured for this cluster", "unavailable"},
		{403, "alerts cover the whole cluster; your grant on this cluster is limited to namespaces (shop)", "forbidden"},
		{429, "too many alert reads: 30 per minute", "rate_limited"},
	} {
		fakeK8sService(t, func(*http.Request) (int, string) { return c.status, `{"detail":"` + c.detail + `"}` })
		out, err := handleAlertsList(ctxFor("c1"), args{"silences": true}, bearer())
		if err != nil {
			t.Fatalf("%d: %v", c.status, err)
		}
		if m := decode(t, out); m["status"] != c.want {
			t.Errorf("%d: %s", c.status, out)
		}
	}
}

// What a silence asks is what an alert asks: the Alerts page's own permission, and a whole-cluster grant.
func TestAlertsList_ASilenceReadAsksWhatTheScreenAsks(t *testing.T) {
	if got := toolScreenTable["alerts_list"](args{"silences": true}); !reflect.DeepEqual(got, []string{"resource.pod.read"}) {
		t.Errorf("permissions: %v", got)
	}
	if got := namespaceGateAnswer(t, "alerts_list", args{"silences": true}); got != "spans the cluster" {
		t.Errorf("a grant limited to namespaces: %q", got)
	}
}

func TestAlertsList_EmptyMissingAndRefused(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"alerts":[],"total":0,"states":{"silenced":2},"byName":[],"silences":[]}`
	})
	out, _ := handleAlertsList(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "state=all") || !strings.Contains(m["hint"].(string), "prometheus_rules with active_only=true") {
		t.Fatalf("empty firing: %s", out)
	}
	out, _ = handleAlertsList(ctxFor("c1"), map[string]interface{}{"state": "all"}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "prometheus_rules") {
		t.Fatalf("empty store: %s", out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 404, `{"detail":"alert store is not configured for this cluster"}`
	})
	out, err := handleAlertsList(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); err != nil || m["status"] != "unavailable" || !strings.Contains(m["alternative"].(string), "prometheus_rules") {
		t.Fatalf("missing store: %s %v", out, err)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 403, `{"detail":"alerts cover the whole cluster; your grant on this cluster is limited to namespaces (shop)"}`
	})
	out, _ = handleAlertsList(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); m["status"] != "forbidden" {
		t.Fatalf("forbidden: %s", out)
	}
	for name, args := range map[string]map[string]interface{}{
		"state firing":         {"state": "firing"},
		"state pending":        {"state": "pending"},
		"label severity":       {"alert_labels": map[string]interface{}{"severity": "critical"}},
		"label with a dash":    {"alert_labels": map[string]interface{}{"team-name": "x"}},
		"label value newline":  {"alert_labels": map[string]interface{}{"team": "a\nb"}},
		"alertname with space": {"alertname": "Disk full"},
	} {
		want := name == "state firing" || name == "label severity" || name == "alertname with space"
		if err := validateToolArgs(args); (err == nil) != want {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, wide := clusterWideTools["alerts_list"]; !wide {
		t.Fatal("alerts_list is not a cluster-wide tool")
	}
}
