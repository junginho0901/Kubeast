package main

import (
	"fmt"
	"net/http"
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

func TestAlertsList_EmptyMissingAndRefused(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"alerts":[],"total":0,"states":{"silenced":2},"byName":[],"silences":[]}`
	})
	out, _ := handleAlertsList(ctxFor("c1"), map[string]interface{}{}, bearer())
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "state=all") {
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
