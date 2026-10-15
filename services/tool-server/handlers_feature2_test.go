package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestHygiene_FilterCapAndRefusals(t *testing.T) {
	findings := []string{}
	for i := 0; i < hygieneFindCap+5; i++ {
		sev := "warning"
		if i%3 == 0 {
			sev = "critical"
		}
		findings = append(findings, `{"check":"pss-level","severity":"`+sev+`","kind":"Namespace","name":"ns`+strconv.Itoa(i)+`","message":"m"}`)
	}
	body := `{"cluster":"c1","interval_days":90,"due":true,"report":{"generated_at":"t","counts":{"critical":1},"checks":[{"id":"pss-level"}],"findings":[` + strings.Join(findings, ",") + `]}}`
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleHygiene(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/hygiene" || (*seen)[0].URL.Query().Get("cluster") != "c1" || (*seen)[0].Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	report := decode(t, out)["report"].(map[string]interface{})
	if len(report["findings"].([]interface{})) != hygieneFindCap || report["findings_total"] != float64(hygieneFindCap+5) || report["truncated"] != true {
		t.Fatalf("cap: %v %v", report["findings_total"], report["truncated"])
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleHygiene(ctxFor("c1"), map[string]interface{}{"severity": "Critical"}, bearer())
	report = decode(t, out)["report"].(map[string]interface{})
	for _, f := range report["findings"].([]interface{}) {
		if f.(map[string]interface{})["severity"] != "critical" {
			t.Fatalf("severity filter leaked: %v", f)
		}
	}
	if report["findings_total"] != float64(69) {
		t.Fatalf("critical count: %v", report["findings_total"])
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"cluster hygiene report is disabled"}` })
	out, err = handleHygiene(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil || decode(t, out)["status"] != "unavailable" {
		t.Fatalf("disabled → unavailable: %v %s", err, out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 403, `{"detail":"Permission denied"}` })
	out, err = handleHygiene(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil || decode(t, out)["status"] != "forbidden" {
		t.Fatalf("forbidden: %v %s", err, out)
	}
}

func TestPolicyReports_SummaryResultsAndNotServed(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"generated_at":"t","reports":3,"totals":{"pass":10,"fail":2},"policies":[{"policy":"p"}],"namespaces":[{"namespace":"shop"}]}`
	})
	out, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/policyreports/summary" || (*seen)[0].URL.Query().Get("namespace") != "shop" {
		t.Fatalf("summary request: %s %s", (*seen)[0].URL.Path, (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); m["view"] != "summary" || m["policies_total"] != float64(1) {
		t.Fatalf("summary: %s", out)
	}

	seen = fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"generated_at":"t","total":0,"rows":[]}`
	})
	out, err = handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results", "results": "fail,warn", "severities": "high", "policy": "require-labels", "kind": "Pod", "search": "web", "limit": 999}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	if (*seen)[0].URL.Path != "/api/v1/policyreports/results" || q.Get("result") != "fail,warn" || q.Get("severity") != "high" || q.Get("policy") != "require-labels" || q.Get("kind") != "Pod" || q.Get("search") != "web" || q.Get("limit") != strconv.Itoa(policyRowsCap) {
		t.Fatalf("results request: %s", (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); !strings.Contains(m["hint"].(string), "Widen the filter") {
		t.Fatalf("empty hint: %s", out)
	}

	// ListIfServed answers [] when the CRD is not served.
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `[]` })
	out, err = handlePolicyReports(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "unavailable" || m["feature"] != "policyReports" {
		t.Fatalf("not served: %s", out)
	}
}

func TestHelmRead_ActionsAndShaping(t *testing.T) {
	var lastBody string
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		b, _ := io.ReadAll(r.Body)
		lastBody = string(b)
		switch {
		case strings.HasSuffix(r.URL.Path, "/helm/releases"):
			return 200, `{"items":[{"name":"kubeast","namespace":"kubeast","revision":107,"status":"deployed","chart":"kubeast","chartVersion":"0.2.0"}]}`
		case strings.HasSuffix(r.URL.Path, "/kubeast/kubeast"):
			return 200, `{"name":"kubeast","namespace":"kubeast","revision":107,"values":{"a":1},"notes":"n","manifest":"` + strings.Repeat("m", 100) + `"}`
		case strings.HasSuffix(r.URL.Path, "/values"):
			return 200, `{"section":"values","content":"` + strings.Repeat("v", helmTextCap+100) + `"}`
		case strings.HasSuffix(r.URL.Path, "/history"):
			return 200, `{"items":[{"revision":1},{"revision":2}]}`
		case strings.Contains(r.URL.Path, "/revisions/5/manifest"):
			return 200, `{"revision":5,"section":"manifest","content":"kind: Deployment"}`
		case strings.HasSuffix(r.URL.Path, "/diff"):
			return 200, `{"from":1,"to":2,"section":"manifest","diff":"-a\n+b"}`
		case strings.HasSuffix(r.URL.Path, "/nope/nope"):
			return 404, `{"detail":"release nope not found"}`
		}
		return 500, `{"detail":"unexpected ` + r.URL.Path + `"}`
	})
	ctx := ctxFor("c1")
	out, err := handleHelmRead(ctx, map[string]interface{}{"what": "list", "namespace": "kubeast", "status": "deployed"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); q.Get("namespace") != "kubeast" || q.Get("status") != "deployed" || (*seen)[0].Method != http.MethodGet {
		t.Fatalf("list request: %s", (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); m["items_total"] != float64(1) || m["namespace"] != "kubeast" {
		t.Fatalf("list: %s", out)
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "get", "namespace": "kubeast", "release": "kubeast"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if _, has := m["manifest"]; has || m["manifest_note"] == nil || m["values"] == nil || m["release"] != "kubeast" {
		t.Fatalf("get drops the manifest, keeps values: %s", out)
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "values", "namespace": "kubeast", "release": "kubeast"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	if m["truncated"] != true || !strings.Contains(m["content"].(string), "truncated by tool-server") {
		t.Fatalf("values text capped: %v", m["truncated"])
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "history", "namespace": "kubeast", "release": "kubeast"}, bearer())
	if err != nil || decode(t, out)["items_total"] != float64(2) {
		t.Fatalf("history: %v %s", err, out)
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "revision", "namespace": "kubeast", "release": "kubeast", "revision": 5, "section": "manifest"}, bearer())
	if err != nil || decode(t, out)["content"] != "kind: Deployment" {
		t.Fatalf("revision: %v %s", err, out)
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "diff", "namespace": "kubeast", "release": "kubeast", "from": 1, "to": 2}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	last := (*seen)[len(*seen)-1]
	if last.Method != http.MethodPost || last.Header.Get("Content-Type") != "application/json" || lastBody != `{"from":1,"section":"manifest","to":2}` {
		t.Fatalf("diff request: %s %s body=%s", last.Method, last.URL.Path, lastBody)
	}
	if decode(t, out)["diff"] != "-a\n+b" {
		t.Fatalf("diff: %s", out)
	}

	out, err = handleHelmRead(ctx, map[string]interface{}{"what": "get", "namespace": "nope", "release": "nope"}, bearer())
	if err != nil || decode(t, out)["status"] != "not_found" {
		t.Fatalf("missing release → not_found: %v %s", err, out)
	}

	for _, args := range []map[string]interface{}{
		{"what": "get"}, {"what": "diff", "namespace": "a", "release": "b", "from": 1}, {"what": "revision", "namespace": "a", "release": "b"}, {"what": "install"},
	} {
		if _, err := handleHelmRead(ctx, args, bearer()); !errors.Is(err, errBadRequest) {
			t.Fatalf("%v should be a bad request: %v", args, err)
		}
	}
}

func TestCost_ScopeFilterAndUnavailable(t *testing.T) {
	body := `{"window":"24h","rows":[{"name":"shop","namespace":"shop","total_cost":3.5},{"name":"db","namespace":"db","total_cost":1},{"name":"kube-system","namespace":"kube-system","total_cost":2}]}`
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleCost(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); q.Get("window") != costDefaultWin || q.Get("aggregate") != "namespace" || (*seen)[0].URL.Path != "/api/v1/cost" {
		t.Fatalf("defaults: %s", (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); m["rows_total"] != float64(3) || m["namespace"] != "all namespaces" {
		t.Fatalf("all rows: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleCost(ctxFor("c1"), map[string]interface{}{"namespace": "db", "window": "7d", "aggregate": "controller"}, bearer())
	if m := decode(t, out); m["rows_total"] != float64(1) || m["window"] != "7d" || m["aggregate"] != "controller" {
		t.Fatalf("namespace filter: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, _ = handleCost(ctxFor("c1", "shop", "db"), map[string]interface{}{}, bearer())
	m := decode(t, out)
	ns, _ := json.Marshal(m["namespace"])
	if m["rows_total"] != float64(2) || string(ns) != `["shop","db"]` {
		t.Fatalf("scoped grant: %s", out)
	}

	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"OpenCost not found in this cluster"}` })
	out, err = handleCost(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil || decode(t, out)["status"] != "unavailable" {
		t.Fatalf("no OpenCost → unavailable: %v %s", err, out)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) { return 404, `{"detail":"cost is off (features.cost.enabled)"}` })
	out, err = handleCost(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil || decode(t, out)["status"] != "unavailable" {
		t.Fatalf("cost off → unavailable: %v %s", err, out)
	}
}

func TestOptimization_OrderCapAndRequired(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"namespace":"shop","window_hours":24,"rows":[{"name":"a","cpu_request_m":100},{"name":"b","cpu_request_m":500,"cpu_recommend_m":200},{"name":"c","cpu_request_m":900}],"totals":{"pods":3}}`
	})
	out, err := handleOptimization(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "window_hours": 48}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); q.Get("namespace") != "shop" || q.Get("window") != "48" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	rows := decode(t, out)["rows"].([]interface{})
	order := []string{}
	for _, r := range rows {
		order = append(order, r.(map[string]interface{})["name"].(string))
	}
	if strings.Join(order, ",") != "b,c,a" {
		t.Fatalf("recommended first, then largest requests: %v", order)
	}
	if _, err := handleOptimization(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("namespace required: %v", err)
	}
}

func TestCanI_And_ResourceGraph(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"allowed":false}` })
	out, err := handleCanI(ctxFor("c1"), map[string]interface{}{"verb": "delete", "resource": "deployments", "group": "apps", "namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[0].URL.Query(); (*seen)[0].URL.Path != "/api/v1/can-i" || q.Get("verb") != "delete" || q.Get("resource") != "deployments" || q.Get("group") != "apps" || q.Get("namespace") != "shop" {
		t.Fatalf("request: %s", (*seen)[0].URL.RawQuery)
	}
	if m := decode(t, out); m["allowed"] != false || m["namespace"] != "shop" || !strings.Contains(m["note"].(string), "signed-in user") {
		t.Fatalf("can-i: %s", out)
	}
	if _, err := handleCanI(ctxFor("c1"), map[string]interface{}{"verb": "get"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("resource required: %v", err)
	}

	var nodes, edges []string
	for i := 0; i < graphNodesCap+10; i++ {
		kind := "Pod"
		if i%10 == 0 {
			kind = "Service"
		}
		nodes = append(nodes, `{"id":"n`+strconv.Itoa(i)+`","kind":"`+kind+`","name":"x"}`)
	}
	for i := 0; i < graphEdgesCap+10; i++ {
		edges = append(edges, `{"from":"n0","to":"n1"}`)
	}
	seen = fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, `{"nodes":[` + strings.Join(nodes, ",") + `],"edges":[` + strings.Join(edges, ",") + `]}`
	})
	out, err = handleResourceGraph(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Path != "/api/v1/namespaces/shop/resource-graph" {
		t.Fatalf("path: %s", (*seen)[0].URL.Path)
	}
	m := decode(t, out)
	counts := m["counts_by_kind"].(map[string]interface{})
	if len(m["nodes"].([]interface{})) != graphNodesCap || len(m["edges"].([]interface{})) != graphEdgesCap || m["truncated"] != true || counts["Service"] != float64(21) || counts["Pod"] != float64(189) {
		t.Fatalf("graph caps/counts: nodes=%d edges=%d counts=%v", len(m["nodes"].([]interface{})), len(m["edges"].([]interface{})), counts)
	}
	if _, err := handleResourceGraph(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("namespace required: %v", err)
	}
}

func TestFeatureArgs2AndGate(t *testing.T) {
	for _, args := range []map[string]interface{}{
		{"what": "diff", "section": "values"}, {"view": "results"}, {"aggregate": "controller", "window": "7d"}, {"release": "kubeast"},
		{"status": "deployed"}, {"policy": "require-labels"}, {"results": "fail,warn"}, {"severities": "high,critical"}, {"check": "pss-level"},
		{"verb": "delete", "group": "networking.k8s.io", "resource": "ingresses"}, {"group": ""},
	} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{
		{"what": "install"}, {"view": "all"}, {"aggregate": "pod"}, {"window": "2d"}, {"release": "--all"}, {"status": "Deployed"},
		{"policy": "a b"}, {"results": "fail;warn"}, {"severities": "High"}, {"verb": "Delete"}, {"group": "Apps"},
	} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	if err := namespaceGate(scoped, "c", "hygiene", map[string]interface{}{}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("hygiene spans the cluster: %v", err)
	}
	if err := namespaceGate(scoped, "c", "cost", map[string]interface{}{}); err != nil {
		t.Fatalf("cost scopes itself: %v", err)
	}
	if err := namespaceGate(scoped, "c", "helm_read", map[string]interface{}{"what": "list"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("a scoped grant lists releases per namespace: %v", err)
	}
	if err := namespaceGate(scoped, "c", "resource_graph", map[string]interface{}{"namespace": "shop"}); err != nil {
		t.Fatalf("own namespace: %v", err)
	}
	_ = context.Background()
}
