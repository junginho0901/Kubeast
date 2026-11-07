package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// namespaceGateCasesFile is read by ai-service's test_ai_tools_pods_files.py: both services refuse the same calls.
const namespaceGateCasesFile = "../ai-service/tests/fixtures/namespace_gate_cases.json"

var namespaceGateRefusals = []string{"spans the cluster", "namespace is required", "outside your grant"}

func namespaceGateAnswer(t *testing.T, tool string, a map[string]interface{}) string {
	t.Helper()
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop", "web"}}}
	err := namespaceGate(scoped, "c", tool, a)
	if err == nil {
		return ""
	}
	if !errors.Is(err, errNamespaceScope) {
		t.Fatalf("%s %v: %v", tool, a, err)
	}
	for _, phrase := range namespaceGateRefusals {
		if strings.Contains(err.Error(), phrase) {
			return phrase
		}
	}
	t.Fatalf("%s %v: a refusal in other words: %v", tool, a, err)
	return ""
}

// Written out by hand: what a grant limited to namespaces may ask of each kind of tool.
func TestNamespaceGate_WhatALimitedGrantMayAsk(t *testing.T) {
	const passes, required, outside, spans = "", "namespace is required", "outside your grant", "spans the cluster"
	for _, c := range []struct {
		tools                     []string
		noNamespace, own, another string
	}{
		// They stay inside the grant by themselves, so naming none is a question they can answer.
		{[]string{"k8s_find_resource", "issues", "cost", "gitops_status", "storage_summary"}, passes, passes, outside},
		// No object data: a namespace says nothing to them.
		{[]string{"k8s_explain", "clusters_list"}, passes, passes, passes},
		// One object of one namespace.
		{[]string{"pod_rbac", "logfiles", "network_policy_effective", "limit_range_violations", "k8s_get_pod_logs"}, required, passes, outside},
		// The Alerts inbox is for whoever reads the cluster as a whole.
		{[]string{"alerts_inbox", "alert_investigate", "alerts_list", "get_cluster_overview"}, spans, spans, spans},
	} {
		for _, tool := range c.tools {
			for _, ask := range []struct {
				args map[string]interface{}
				want string
			}{
				{map[string]interface{}{}, c.noNamespace},
				{map[string]interface{}{"namespace": "shop"}, c.own},
				{map[string]interface{}{"namespace": "db"}, c.another},
			} {
				if got := namespaceGateAnswer(t, tool, ask.args); got != ask.want {
					t.Errorf("%s %v: %q, want %q", tool, ask.args, got, ask.want)
				}
			}
		}
	}
}

// Every tool, with what a call can say about namespaces. ai-service refuses first, so the two must not differ.
func TestNamespaceGateCasesFixture(t *testing.T) {
	asks := []map[string]interface{}{
		{},
		{"namespace": "shop"},
		{"namespace": "web"},
		{"namespace": "db"},
		{"namespace": " shop "},
		{"all_namespaces": true},
		{"all_namespaces": "true"},
		{"namespace": "shop", "all_namespaces": true},
		{"namespace": "shop", "all_namespaces": false},
	}
	names := toolScreenTableNames()
	sort.Strings(names)
	type gateCase struct {
		Tool    string                 `json:"tool"`
		Args    map[string]interface{} `json:"args"`
		Refused string                 `json:"refused"`
	}
	cases := make([]gateCase, 0, len(names)*len(asks))
	for _, name := range names {
		for _, ask := range asks {
			cases = append(cases, gateCase{name, ask, namespaceGateAnswer(t, name, ask)})
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(map[string]interface{}{"cluster": "c", "namespaces": []string{"shop", "web"}, "cases": cases}); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_TOOL_PERMISSION_CASES") == "1" {
		if err := os.WriteFile(namespaceGateCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(namespaceGateCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_TOOL_PERMISSION_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("namespace_gate_cases.json is not these cases: rerun with UPDATE_TOOL_PERMISSION_CASES=1")
	}
}

// A namespace-scoped grant may search (the handler stays inside its
// namespaces) and read API schema, but not name a namespace outside the grant.
func TestNamespaceGate_FindAndExplain(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web"}); err != nil {
		t.Fatalf("find without a namespace passes (the handler scopes it): %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web", "namespace": "web"}); err != nil {
		t.Fatalf("find in an own namespace: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "web", "namespace": "db"}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("find in another namespace is refused: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_explain", map[string]interface{}{"resource": "pods"}); err != nil {
		t.Fatalf("explain returns schema, not objects: %v", err)
	}
	if err := namespaceGate(scoped, "c", "k8s_get_events", map[string]interface{}{"all_namespaces": true}); !errors.Is(err, errNamespaceScope) {
		t.Fatalf("events across namespaces still need a namespace from a scoped grant: %v", err)
	}
}

// Asking for every namespace stays inside a limited grant whichever way the flag comes and whatever namespace goes with it.
func TestNamespaceGate_AllNamespacesStaysInsideTheGrant(t *testing.T) {
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	for _, tool := range []string{"k8s_get_resources", "k8s_get_events"} {
		for _, flag := range []interface{}{true, "true", "TRUE", float64(1)} {
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"namespace": "web", "all_namespaces": flag}); !errors.Is(err, errNamespaceScope) {
				t.Errorf("%s with an own namespace and all_namespaces=%v: %v", tool, flag, err)
			}
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"all_namespaces": flag}); !errors.Is(err, errNamespaceScope) {
				t.Errorf("%s with all_namespaces=%v alone: %v", tool, flag, err)
			}
		}
		for _, flag := range []interface{}{false, "false", nil} {
			if err := namespaceGate(scoped, "c", tool, map[string]interface{}{"namespace": "web", "all_namespaces": flag}); err != nil {
				t.Errorf("%s in an own namespace with all_namespaces=%v: %v", tool, flag, err)
			}
		}
	}
	if err := namespaceGate(scoped, "c", "k8s_find_resource", map[string]interface{}{"query": "x", "all_namespaces": true}); !errors.Is(err, errNamespaceScope) {
		t.Errorf("a tool that narrows by itself, the flag named: %v", err)
	}
	if err := namespaceGate(scoped, "other", "k8s_get_resources", map[string]interface{}{"all_namespaces": true}); err != nil {
		t.Errorf("limited on another cluster only: %v", err)
	}
	whole := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}}
	if err := namespaceGate(whole, "c", "k8s_get_resources", map[string]interface{}{"namespace": "web", "all_namespaces": true}); err != nil {
		t.Errorf("no limit: %v", err)
	}
}
