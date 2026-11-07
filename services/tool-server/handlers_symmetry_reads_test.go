package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestCanI_AsksAboutTheObjectItIsGiven(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"allowed":true}` })
	out, err := handleCanI(ctxFor("c1"), map[string]interface{}{"verb": "delete", "resource": "configmaps", "namespace": "shop", "name": "app-config"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[0].URL.Query().Get("name"); got != "app-config" {
		t.Errorf("name sent to the route = %q, want app-config", got)
	}
	if got := decode(t, out)["name"]; got != "app-config" {
		t.Errorf("name in the answer = %v, want app-config: %s", got, out)
	}
}

func TestCanI_WithoutANameAsksAboutTheKind(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"allowed":true}` })
	out, err := handleCanI(ctxFor("c1"), map[string]interface{}{"verb": "delete", "resource": "configmaps", "namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].URL.Query().Has("name") {
		t.Errorf("a name was sent: %s", (*seen)[0].URL.RawQuery)
	}
	if _, named := decode(t, out)["name"]; named {
		t.Errorf("the answer names an object: %s", out)
	}
}

const costByNamespace = `{"window":"24h","aggregate":"controller","rows":[
	{"name":"web","namespace":"shop","cpu_cost":1,"ram_cost":0.5,"gpu_cost":0,"pv_cost":0.25,"network_cost":0.125,"load_balancer_cost":0.5,"total_cost":2.375,"cpu_core_hours":10,"ram_byte_hours":100},
	{"name":"api","namespace":"shop","cpu_cost":2,"ram_cost":1,"gpu_cost":4,"pv_cost":0,"network_cost":0,"load_balancer_cost":0,"total_cost":7,"cpu_core_hours":20,"ram_byte_hours":200},
	{"name":"pg","namespace":"db","cpu_cost":8,"ram_cost":8,"gpu_cost":0,"pv_cost":8,"network_cost":8,"load_balancer_cost":0,"total_cost":32,"cpu_core_hours":80,"ram_byte_hours":800}],
	"totals":{"cpu_cost":11,"ram_cost":9.5,"gpu_cost":4,"pv_cost":8.25,"network_cost":8.125,"load_balancer_cost":0.5,"total_cost":41.375,"cpu_core_hours":110,"ram_byte_hours":1100}}`

func costTotalsOf(t *testing.T, out string) map[string]interface{} {
	t.Helper()
	totals, ok := decode(t, out)["totals"].(map[string]interface{})
	if !ok {
		t.Fatalf("no totals: %s", out)
	}
	return totals
}

func TestCost_ANamespaceAddsUpItsOwnRows(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, costByNamespace })
	out, err := handleCost(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "aggregate": "controller"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"cpu_cost": 3, "ram_cost": 1.5, "gpu_cost": 4, "pv_cost": 0.25, "network_cost": 0.125, "load_balancer_cost": 0.5, "total_cost": 9.375, "cpu_core_hours": 30, "ram_byte_hours": 300}
	totals := costTotalsOf(t, out)
	for key, value := range want {
		if totals[key] != value {
			t.Errorf("totals.%s = %v, want %v", key, totals[key], value)
		}
	}
	if len(totals) != len(want) {
		t.Errorf("totals holds %d values, want %d: %v", len(totals), len(want), totals)
	}
}

func TestCost_WithoutANamespaceTheTotalsAreTheRoutes(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, costByNamespace })
	out, err := handleCost(ctxFor("c1"), map[string]interface{}{"aggregate": "controller"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if got := costTotalsOf(t, out)["total_cost"]; got != 41.375 {
		t.Errorf("totals.total_cost = %v, want the route's 41.375", got)
	}
}

func TestCost_ANamespaceWithNoRowsCostsNothing(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, costByNamespace })
	out, err := handleCost(ctxFor("c1"), map[string]interface{}{"namespace": "empty", "aggregate": "controller"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if got := costTotalsOf(t, out)["total_cost"]; got != float64(0) {
		t.Errorf("totals.total_cost = %v, want 0", got)
	}
}

func TestCost_ANamespacesTotalsCountTheRowsTheAnswerCuts(t *testing.T) {
	rows := make([]string, 0, rowsCap+5)
	for i := 0; i < rowsCap+5; i++ {
		rows = append(rows, fmt.Sprintf(`{"name":"w%d","namespace":"shop","total_cost":1}`, i))
	}
	body := `{"rows":[` + strings.Join(rows, ",") + `],"totals":{"total_cost":999}}`
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, body })
	out, err := handleCost(ctxFor("c1"), map[string]interface{}{"namespace": "shop", "aggregate": "controller"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	if got := m["totals"].(map[string]interface{})["total_cost"]; got != float64(rowsCap+5) {
		t.Errorf("totals.total_cost = %v, want %d", got, rowsCap+5)
	}
	if got := len(m["rows"].([]interface{})); got != rowsCap {
		t.Errorf("rows = %d, want the cap %d", got, rowsCap)
	}
}

func TestPolicyReports_AsksForThePageTheScreenAsksFor(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"generated_at":"t","total":520,"rows":[]}` })
	_, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results", "policy_source": "kyverno", "offset": 100, "sort": "policy", "dir": "desc", "limit": 50}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	want := map[string]string{"source": "kyverno", "offset": "100", "sort": "policy", "dir": "desc", "limit": "50"}
	for key, value := range want {
		if got := q.Get(key); got != value {
			t.Errorf("%s sent to the route = %q, want %q", key, got, value)
		}
	}
}

func TestPolicyReports_WithoutThemTheFirstPageInTheScreensOrder(t *testing.T) {
	seen := fakeK8sService(t, func(r *http.Request) (int, string) { return 200, `{"generated_at":"t","total":0,"rows":[]}` })
	if _, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results"}, bearer()); err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	for _, key := range []string{"source", "offset", "sort", "dir"} {
		if q.Has(key) {
			t.Errorf("%s was sent: %s", key, (*seen)[0].URL.RawQuery)
		}
	}
}

func policyPage(total, from, n int) string {
	rows := make([]string, 0, n)
	for i := 0; i < n; i++ {
		rows = append(rows, fmt.Sprintf(`{"namespace":"shop","kind":"Pod","name":"p%d","policy":"p","result":"fail","source":"kyverno"}`, from+i))
	}
	return fmt.Sprintf(`{"generated_at":"t","truncated":false,"total":%d,"rows":[%s]}`, total, strings.Join(rows, ","))
}

func TestPolicyReports_SaysWhereTheNextPageStarts(t *testing.T) {
	cases := []struct {
		name         string
		offset, rows int
		want         interface{}
	}{
		{"a first page of more", 0, 100, float64(100)},
		{"a page in the middle", 100, 100, float64(200)},
		{"the last page", 500, 20, nil},
		{"past the end", 600, 0, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fakeK8sService(t, func(r *http.Request) (int, string) { return 200, policyPage(520, c.offset, c.rows) })
			out, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results", "offset": c.offset}, bearer())
			if err != nil {
				t.Fatal(err)
			}
			m := decode(t, out)
			if m["next_offset"] != c.want {
				t.Errorf("next_offset = %v, want %v", m["next_offset"], c.want)
			}
			if m["total"] != float64(520) {
				t.Errorf("total = %v, want 520", m["total"])
			}
		})
	}
}

func TestPolicyReports_TheCountsComeBeforeTheRows(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, policyPage(520, 0, 100) })
	out, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	rows := strings.Index(out, `"rows":`)
	for _, key := range []string{`"total":`, `"next_offset":`, `"truncated":`} {
		if at := strings.Index(out, key); at < 0 || at > rows {
			t.Errorf("%s at %d, rows at %d: a model's cut would lose it", key, at, rows)
		}
	}
}

// Why the cluster reports were not read reaches the model with the counts it qualifies, before a cut could lose it.
func TestPolicyReports_WhatCouldNotBeReadComesBeforeTheRows(t *testing.T) {
	const reason = "cluster reports are outside a grant limited to namespaces"
	fakeK8sService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/summary") {
			return 200, `{"totals":{"fail":1},"reports":1,"policies":[],"namespaces":[],"cluster_reports_error":"` + reason + `"}`
		}
		return 200, strings.Replace(policyPage(520, 0, 100), `"truncated":false`, `"truncated":false,"cluster_reports_error":"`+reason+`"`, 1)
	})
	for view, last := range map[string]string{"results": `"rows":`, "summary": `"policies":`} {
		out, err := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": view, "namespace": "shop"}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		if got := decode(t, out)["cluster_reports_error"]; got != reason {
			t.Errorf("%s: cluster_reports_error = %v", view, got)
		}
		if at, end := strings.Index(out, `"cluster_reports_error":`), strings.Index(out, last); at < 0 || at > end {
			t.Errorf("%s: the reason at %d, the list at %d: a model's cut would lose it", view, at, end)
		}
	}
}

func TestPolicyReports_TheClustersCutStaysAndAPageIsNotACut(t *testing.T) {
	fakeK8sService(t, func(r *http.Request) (int, string) { return 200, policyPage(520, 0, 100) })
	out, _ := handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results"}, bearer())
	if got := decode(t, out)["truncated"]; got != false {
		t.Errorf("truncated on a page of an uncut list = %v, want false", got)
	}
	fakeK8sService(t, func(r *http.Request) (int, string) {
		return 200, strings.Replace(policyPage(520, 0, 100), `"truncated":false`, `"truncated":true`, 1)
	})
	out, _ = handlePolicyReports(ctxFor("c1"), map[string]interface{}{"view": "results"}, bearer())
	if got := decode(t, out)["truncated"]; got != true {
		t.Errorf("truncated from the cluster's read limit = %v, want true", got)
	}
}

func TestValidateToolArgs_ThePolicyReportsPageArguments(t *testing.T) {
	for _, args := range []map[string]interface{}{
		{"sort": "result"}, {"sort": "policy"}, {"sort": "namespace"}, {"sort": "name"},
		{"dir": "asc"}, {"dir": "desc"},
		{"policy_source": "kyverno"}, {"policy_source": "Trivy Operator"},
	} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{
		{"sort": "severity"}, {"dir": "up"}, {"policy_source": "a\nb"}, {"policy_source": strings.Repeat("x", 254)},
	} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", args, err)
		}
	}
}

func TestNodesLog_TheCapKeepsTheNewestLines(t *testing.T) {
	var lines []string
	for i := 0; len(strings.Join(lines, "\n")) <= nodeLogTextCap; i++ {
		lines = append(lines, fmt.Sprintf("line %06d %s", i, strings.Repeat("x", 80)))
	}
	newest, oldest := lines[len(lines)-1], lines[0]
	fakeKubectl(t, func(args []string) (string, error) { return strings.Join(lines, "\n"), nil })
	out, err := handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m := decode(t, out)
	text, _ := m["text"].(string)
	if !strings.Contains(text, newest) {
		t.Errorf("the newest line is gone: the text ends %q", text[max(0, len(text)-120):])
	}
	if strings.Contains(text, oldest) {
		t.Errorf("the oldest line is still there")
	}
	if m["truncated"] != true {
		t.Errorf("truncated = %v, want true", m["truncated"])
	}
}
