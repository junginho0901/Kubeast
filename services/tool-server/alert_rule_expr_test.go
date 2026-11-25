package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// alertExprCasesFile is read by ai-service's test_alert_rule_expression.py too: the alert view an investigation sends
// and these tools' answers give the model the same expression.
const alertExprCasesFile = "../ai-service/tests/fixtures/alert_expr_cases.json"

func TestRuleExpressions_SharedCases(t *testing.T) {
	raw, err := os.ReadFile(alertExprCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name string   `json:"name"`
			Link string   `json:"link"`
			Expr []string `json:"expr"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 20 {
		t.Fatalf("%d cases", len(file.Cases))
	}
	for _, c := range file.Cases {
		if got := ruleExpressions(c.Link); len(got) != len(c.Expr) || (len(got) > 0 && !reflect.DeepEqual(got, c.Expr)) {
			t.Errorf("%s: %q, want %q", c.Name, got, c.Expr)
		}
	}
}

func TestKeepRuleExpression_TakesBothLinksOut(t *testing.T) {
	for _, c := range []struct {
		link interface{}
		want interface{}
	}{
		{"http://prom:9090/graph?g0.expr=up+%3D%3D+0&g0.tab=1", "up == 0"},
		{"http://prom:9090/graph?g1.expr=b&g0.expr=a", []string{"a", "b"}},
		{"https://grafana.example/alerting/grafana/u1/view?orgId=1", nil},
		{"", nil},
		{nil, nil},
		{42, nil},
	} {
		m := map[string]interface{}{"generator_url": c.link, "alertmanager_url": "http://am:9093", "receiver": "kubeast"}
		keepRuleExpression(m, m["generator_url"])
		_, hasLink := m["generator_url"]
		_, hasAM := m["alertmanager_url"]
		expr, hasExpr := m["expr"]
		if hasLink || hasAM || m["receiver"] != "kubeast" || hasExpr != (c.want != nil) || (c.want != nil && !reflect.DeepEqual(expr, c.want)) {
			t.Errorf("%v: %v", c.link, m)
		}
	}
}
