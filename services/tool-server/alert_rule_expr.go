// What the model reads of an alert's links. Its generatorURL is the address of the server that sent it (often an
// in-cluster Prometheus) with the rule's expression in the query, and its Alertmanager's address is the install's too:
// a tool result keeps the expression only, as ai-service's alert view does (runner.rule_expressions, the same rule and
// ai-service/tests/fixtures/alert_expr_cases.json). The screens and the routes give both links as they came.

package main

import (
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// A graph link's query names each panel's expression g0.expr, g1.expr, … (Prometheus, Thanos and the rulers made like them).
var exprKey = regexp.MustCompile(`^g([0-9]{1,3})\.expr$`)

// ruleExpressions gives the expressions in a link's query — the text after its first "?" and before its "#" — in panel
// order, the first of a panel named twice. None for an empty value, text that is not a link or a link of another form
// (a Grafana rule's page); the address is never read.
func ruleExpressions(link string) []string {
	beforeFragment, _, _ := strings.Cut(link, "#")
	_, query, ok := strings.Cut(beforeFragment, "?")
	if !ok {
		return nil
	}
	byPanel := map[int]string{}
	for _, pair := range strings.Split(query, "&") {
		rawKey, rawValue, _ := strings.Cut(pair, "=")
		key, keyErr := url.QueryUnescape(rawKey)
		value, valueErr := url.QueryUnescape(rawValue)
		match := exprKey.FindStringSubmatch(key)
		value = strings.TrimSpace(value)
		if keyErr != nil || valueErr != nil || match == nil || value == "" {
			continue
		}
		panel, _ := strconv.Atoi(match[1])
		if _, seen := byPanel[panel]; !seen {
			byPanel[panel] = value
		}
	}
	var out []string
	for _, panel := range slices.Sorted(maps.Keys(byPanel)) {
		out = append(out, byPanel[panel])
	}
	return out
}

// keepRuleExpression takes an alert's two links out of m and puts in the rule's expression as expr: one as text, several
// as a list, none as nothing.
func keepRuleExpression(m map[string]interface{}, generatorURL interface{}) {
	delete(m, "generator_url")
	delete(m, "alertmanager_url")
	link, _ := generatorURL.(string)
	switch exprs := ruleExpressions(link); len(exprs) {
	case 0:
	case 1:
		m["expr"] = exprs[0]
	default:
		m["expr"] = exprs
	}
}
