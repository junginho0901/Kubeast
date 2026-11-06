package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// toolScreenCasesFile is read by ai-service's test_tool_screen_permissions.py: both services ask the same.
const toolScreenCasesFile = "../ai-service/tests/fixtures/tool_screen_permission_cases.json"

type screenCase struct {
	Tool string                 `json:"tool"`
	Args map[string]interface{} `json:"args"`
	Want []string               `json:"want"`
}

type args = map[string]interface{}

func perms(p ...string) []string { return p }

// The read tools whose screen asks for no permission of its own: a role on the cluster and the cluster's RBAC decide
// there, and so they do here.
var readToolsTheScreenLeavesToTheCluster = []string{
	"k8s_get_resources", "k8s_get_resource_yaml", "k8s_describe_resource", "k8s_get_events", "k8s_get_available_api_resources",
	"k8s_get_cluster_configuration", "get_cluster_overview", "get_node_metrics", "get_pod_metrics", "k8s_check_service_connectivity",
	"k8s_find_resource", "k8s_explain", "prometheus_query", "prometheus_metrics", "prometheus_labels", "prometheus_rules", "prometheus_targets",
	"traces_search", "traces_get", "traces_tags", "traces_metrics", "traces_compare", "issues", "gitops_status", "optimization", "can_i",
	"resource_graph", "k8s_jq_query", "k8s_tabular_query", "k8s_count",
	"clusters_list",
	"pod_rbac",
	"storage_summary",
	"limit_range_violations",
	"timeline", "gpu",
}

// The tools of the seeded Read role (auth-service repository.ReadAIToolPermissions).
var readRoleTools = []string{
	"get_cluster_overview", "get_pod_metrics", "get_node_metrics", "k8s_get_resources", "k8s_get_resource_yaml", "k8s_describe_resource",
	"k8s_get_pod_logs", "k8s_get_events", "k8s_get_available_api_resources", "k8s_get_cluster_configuration", "k8s_check_service_connectivity",
	"k8s_find_resource", "k8s_explain", "issues", "prometheus_query", "prometheus_metrics", "prometheus_labels", "prometheus_rules",
	"prometheus_targets", "logsearch", "loki_query", "loki_labels", "loki_patterns", "traces_search", "traces_get", "traces_tags",
	"traces_metrics", "traces_compare", "alerts_list", "policy_reports", "helm_read", "cost", "optimization", "can_i", "network_policy_check",
	"network_flows", "network_drops", "network_top_flows", "resource_graph", "k8s_jq_query", "k8s_tabular_query", "k8s_count", "gitops_status",
	"clusters_list",
	"pod_rbac",
	"logfiles",
	"storage_summary",
	"network_policy_effective",
	"limit_range_violations",
	"alerts_inbox",
	"timeline", "gpu",
}

// The seeded Write role's list (auth-service repository_schema.go).
var writeRolePerms = []string{
	"menu.*", "resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete",
	"resource.cronjob.suspend", "resource.cronjob.trigger", "resource.secret.reveal", "resource.alert.silence", "resource.pod.logfile",
	"resource.helm.read", "resource.helm.rollback", "resource.helm.upgrade", "resource.helm.test", "ai.tool.*", "ai.mcp.use",
}

// Written out by hand: what the route a screen calls for the same thing asks for.
func screenPermissionCases() []screenCase {
	var cases []screenCase
	add := func(tool string, a args, want ...string) {
		if a == nil {
			a = args{}
		}
		cases = append(cases, screenCase{Tool: tool, Args: a, Want: want})
	}
	for _, tool := range readToolsTheScreenLeavesToTheCluster {
		add(tool, nil)
	}
	add("k8s_get_resources", args{"resource_type": "secrets"})
	add("k8s_get_resources", args{"resource_type": "all"})
	add("k8s_describe_resource", args{"resource_type": "secret", "resource_name": "x"})

	// Reads a screen's route asks a permission for.
	add("k8s_get_pod_logs", args{"pod_name": "web"}, "resource.pod.read")
	for _, tool := range []string{"alerts_list", "logsearch", "loki_query", "loki_labels", "loki_patterns"} {
		add(tool, nil, "resource.pod.read")
	}
	add("policy_reports", nil, "resource.policyreport.read")
	add("helm_read", nil, "resource.helm.read")
	add("cost", nil, "resource.cost.read")
	add("network_policy_check", nil, "resource.networkpolicy.read")
	for _, tool := range []string{"network_flows", "network_drops", "network_top_flows"} {
		add(tool, nil, "resource.networkflow.read")
	}
	add("hygiene", nil, "resource.hygiene.scan")
	add("audit_search", nil, "admin.audit.read")
	add("nodes_stats_summary", nil, "admin.nodes.read")
	add("nodes_log", args{"node": "n1"}, "admin.nodes.read")
	// The alert window's "Investigate now": its own permission and reading the alert.
	add("alert_investigate", args{"alert_id": "a1"}, "resource.alert.investigate", "resource.pod.read")
	add("alert_investigate", args{"alertname": "HighLoad", "status_only": true}, "resource.alert.investigate", "resource.pod.read")
	// The Log files tab's permission, listing or reading.
	add("logfiles", args{"namespace": "shop", "pod_name": "web"}, "resource.pod.logfile")
	add("logfiles", args{"namespace": "shop", "pod_name": "web", "path": "/var/log/app/app.log"}, "resource.pod.logfile")
	add("network_policy_effective", args{"namespace": "shop", "pod": "web"}, "resource.networkpolicy.read")
	// The Alerts inbox, the list and one alert.
	add("alerts_inbox", nil, "resource.pod.read")
	add("alerts_inbox", args{"alert_id": "a1"}, "resource.pod.read")
	add("access_review", nil, "admin.review.read")
	add("ai_usage", nil, "admin.audit.read")
	add("access_requests", nil, "admin.users.update")
	add("audit_integrity", nil, "admin.audit.read")
	add("hygiene_history", nil, "resource.hygiene.scan")

	// One name in every spelling kubectl takes.
	del := func(resourceType string, want ...string) {
		add("k8s_delete_resource", args{"resource_type": resourceType, "resource_name": "x"}, want...)
	}
	for _, spelling := range []string{"secret", "secrets", "Secret", "SECRETS", "secret.v1", "secrets.v1", "secrets.v1.core", " secrets "} {
		del(spelling, "resource.secret.delete")
	}
	del("cm", "resource.configmap.delete")
	del("configmaps", "resource.configmap.delete")
	del("ConfigMap", "resource.configmap.delete")
	del("deployment.apps", "resource.deployment.delete")
	del("deployments.v1.apps", "resource.deployment.delete")
	del("deploy", "resource.deployment.delete")
	del("po", "resource.pod.delete")
	del("svc", "resource.service.delete")
	del("sts", "resource.statefulset.delete")
	del("ds", "resource.daemonset.delete")
	del("rs", "resource.replicaset.delete")
	del("cj", "resource.cronjob.delete")
	del("ing", "resource.ingress.delete")
	del("netpol", "resource.networkpolicy.delete")
	del("sa", "resource.serviceaccount.delete")
	del("ns", "resource.namespace.delete")
	del("no", "resource.node.delete")
	del("sc", "resource.storageclass.delete")
	del("ep", "resource.endpoints.delete")
	del("quota", "resource.resourcequota.delete")
	del("limits", "resource.limitrange.delete")
	del("pc", "resource.priorityclass.delete")
	del("hpa", "resource.hpa.delete")
	del("horizontalpodautoscalers", "resource.hpa.delete")
	del("horizontalpodautoscaler.autoscaling", "resource.hpa.delete")
	del("vpa", "resource.vpa.delete")
	del("pdb", "resource.pdb.delete")
	del("poddisruptionbudgets.policy", "resource.pdb.delete")
	del("pv", "resource.pv.delete")
	del("persistentvolumes", "resource.pv.delete")
	del("pvc", "resource.pvc.delete")
	del("persistentvolumeclaim", "resource.pvc.delete")
	del("crd", "resource.crd.delete")
	del("crds", "resource.crd.delete")
	del("customresourcedefinitions.apiextensions.k8s.io", "resource.crd.delete")
	del("gtw", "resource.gateway.delete")
	del("httproutes.gateway.networking.k8s.io", "resource.httproute.delete")
	del("clusterrolebindings.rbac.authorization.k8s.io", "resource.clusterrolebinding.delete")
	del("validatingadmissionpolicies", "resource.validatingadmissionpolicy.delete")
	// A kind without a name of its own, as on the screens.
	del("widgets", "resource.customresource.delete")
	del("widgets.example.com", "resource.customresource.delete")
	del("replicationcontrollers", "resource.customresource.delete")
	del("rc", "resource.customresource.delete")
	// Several at once: every one is asked for.
	del("configmaps,secrets", "resource.configmap.delete", "resource.secret.delete")
	del("po,svc,widgets.example.com", "resource.customresource.delete", "resource.pod.delete", "resource.service.delete")
	del("Secret, ConfigMap", "resource.configmap.delete", "resource.secret.delete")
	del("secret,secrets,SECRET", "resource.secret.delete")
	// A name for several kinds, and what cannot be read, are every kind.
	for _, spelling := range []string{"all", "ALL", "api-extensions", "gateway-api", "configmaps,all", "", " ", ",", "secrets,"} {
		del(spelling, "resource.*.delete")
	}
	add("k8s_delete_resource", args{"resource_type": "configmaps", "all": true}, "resource.configmap.delete")
	add("k8s_delete_resource", nil, "resource.*.delete")

	for _, tool := range []string{"k8s_patch_resource", "k8s_annotate_resource", "k8s_remove_annotation", "k8s_label_resource", "k8s_remove_label", "k8s_scale"} {
		add(tool, args{"resource_type": "deployment", "resource_name": "web"}, "resource.deployment.edit")
		add(tool, args{"resource_type": "secrets,configmaps", "resource_name": "web"}, "resource.configmap.edit", "resource.secret.edit")
		add(tool, args{"resource_type": "all", "resource_name": "web"}, "resource.*.edit")
	}
	add("k8s_patch_resource", args{"resource_type": "node", "resource_name": "n1"}, "resource.node.edit")

	rollout := func(action string, want ...string) {
		add("k8s_rollout", args{"action": action, "resource_type": "statefulsets.apps", "resource_name": "web"}, want...)
	}
	rollout("restart", "resource.statefulset.edit")
	rollout("pause", "resource.statefulset.edit")
	rollout("resume", "resource.statefulset.edit")
	rollout("status")
	rollout("history")
	rollout(" STATUS ")
	rollout("undo", "resource.workload.rollback")
	rollout("UNDO", "resource.workload.rollback")
	rollout("", "resource.statefulset.edit")
	rollout("anything", "resource.statefulset.edit")
	add("k8s_execute_command", args{"pod_name": "web", "command": []interface{}{"ls"}}, "resource.pod.exec")

	cm := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n"
	manifest := func(text string, verb string, want ...string) {
		for _, tool := range manifestToolsFor(verb) {
			add(tool, args{"yaml_content": text}, want...)
		}
	}
	for _, verb := range []string{"create", "edit"} {
		p := func(name string) string { return "resource." + name + "." + verb }
		manifest(cm, verb, p("configmap"))
		manifest(cm+"---\n"+secret, verb, p("configmap"), p("secret"))
		manifest("---\n"+cm+"--- # the next one\n"+secret+"---\n", verb, p("configmap"), p("secret"))
		manifest("# only a comment\n---\n"+secret, verb, p("secret"))
		manifest("apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: a\n- apiVersion: v1\n  kind: ConfigMap\n  metadata:\n    name: b\n", verb, p("configmap"), p("secret"))
		manifest("apiVersion: v1\nkind: SecretList\nitems:\n- metadata:\n    name: a\n", verb, p("secret"))
		manifest("apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: List\n  items:\n  - apiVersion: v1\n    kind: Secret\n    metadata:\n      name: a\n", verb, p("secret"))
		manifest("apiVersion: v1\nkind: ConfigMap\nITEMS:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: a\n", verb, p("configmap"), p("secret"))
		manifest(`{"apiVersion":"v1","kind":"Secret","metadata":{"name":"a"}}`, verb, p("secret"))
		manifest(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"a"}}{"apiVersion":"v1","kind":"Secret","metadata":{"name":"b"}}`, verb, p("configmap"), p("secret"))
		manifest("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\n", verb, p("deployment"))
		manifest("apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: a\n", verb, p("hpa"))
		manifest("apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: a\n", verb, p("customresource"))
		for _, unread := range []string{"", "   ", "just text", "- a\n- b\n", "kind: [", "metadata:\n  name: a\n", "kind: 5\n", "apiVersion: v1\nkind: List\nitems: nope\n", "apiVersion: v1\nkind: List\nitems:\n- text\n", "apiVersion: v1\nkind: List\nitems: []\n", cm + "--- not a separator\n" + secret} {
			manifest(unread, verb, "resource.*."+verb)
		}
	}
	// The same arguments the handlers read, in the order they read them.
	add("k8s_apply_manifest", args{"yaml_content": secret, "manifest": cm, "resource_manifest": cm}, "resource.secret.edit")
	add("k8s_apply_manifest", args{"manifest": secret, "resource_manifest": cm}, "resource.secret.edit")
	add("k8s_apply_manifest", args{"resource_manifest": secret}, "resource.secret.edit")
	add("k8s_apply_manifest", args{"resource_manifest": map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]interface{}{"name": "a"}}}, "resource.secret.edit")
	add("k8s_apply_manifest", args{"yaml_content": "  ", "manifest": secret}, "resource.secret.edit")
	add("k8s_apply_manifest", nil, "resource.*.edit")
	add("k8s_create_resource", nil, "resource.*.create")
	add("k8s_diff", args{"yaml_content": secret}, "resource.secret.edit")
	add("k8s_diff", nil, "resource.*.edit")
	return cases
}

func manifestToolsFor(verb string) []string {
	if verb == "create" {
		return []string{"k8s_create_resource"}
	}
	return []string{"k8s_apply_manifest", "k8s_diff"}
}

func TestToolAppPermissions_EachToolAsksWhatItsScreenAsks(t *testing.T) {
	for _, c := range screenPermissionCases() {
		got, listed := toolAppPermissions(c.Tool, c.Args)
		if !listed {
			t.Errorf("%s %v: not in the table", c.Tool, c.Args)
			continue
		}
		if len(got) == 0 && len(c.Want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.Want) {
			t.Errorf("%s %v: asks %v, want %v", c.Tool, c.Args, got, c.Want)
		}
	}
}

// A new tool has to say what it asks for: it is closed until it is in the table, and this fails until a case says so.
func TestEveryToolIsInTheTableAndHasACase(t *testing.T) {
	registry := buildToolRegistry()
	covered := map[string]bool{}
	for _, c := range screenPermissionCases() {
		covered[c.Tool] = true
	}
	for name := range registry {
		if _, listed := toolAppPermissions(name, args{}); !listed {
			t.Errorf("%s has no line in the table", name)
		}
		if !covered[name] {
			t.Errorf("%s has no case in screenPermissionCases", name)
		}
	}
	for _, name := range toolScreenTableNames() {
		if _, ok := registry[name]; !ok {
			t.Errorf("%s is in the table but is not a tool", name)
		}
	}
	if len(registry) < 50 {
		t.Fatalf("%d tools: the registry was not read", len(registry))
	}
}

func TestAToolNotInTheTableIsRefusedToEveryone(t *testing.T) {
	if got, listed := toolAppPermissions("a_tool_nobody_decided", args{}); listed {
		t.Fatalf("a_tool_nobody_decided is listed and asks %v", got)
	}
	for _, perms := range []auth.PermissionMatrix{{"alpha": {"ai.tool.*"}}, {"alpha": {"*"}}, {"*": {"*"}}} {
		v := fakeValidator{payload: auth.TokenPayload{Perms: perms}}
		_, status, err := authorizeToolCall(v, hdr("t"), "a_tool_nobody_decided", "alpha", args{})
		if status != http.StatusForbidden || !errors.Is(err, errForbidden) {
			t.Errorf("%v: status %d err %v, want 403", perms, status, err)
		}
	}
}

// Every permission name has its spellings, so a kind that gets a name of its own cannot fall to customresource here.
func TestEveryPermissionNameHasItsSpellings(t *testing.T) {
	for _, name := range auth.PermResourceNames() {
		if name == "customresource" {
			continue
		}
		if _, ok := resourceSpellings[name]; !ok {
			t.Errorf("%s has no line in resourceSpellings", name)
		}
		if got := resourcePermName(name); got != name {
			t.Errorf("resourcePermName(%q) = %q", name, got)
		}
	}
	names := map[string]bool{}
	for _, name := range auth.PermResourceNames() {
		names[name] = true
	}
	for name, spellings := range resourceSpellings {
		if !names[name] {
			t.Errorf("resourceSpellings has %q, which is not a permission name", name)
		}
		for _, spelling := range spellings {
			if got := resourcePermName(spelling); got != name {
				t.Errorf("resourcePermName(%q) = %q, want %q", spelling, got, name)
			}
		}
	}
}

// What a custom role may do through the AI, on the routed cluster, written out by hand.
func TestAuthorizeToolCall_ACustomRoleDoesNoMoreThanOnTheScreen(t *testing.T) {
	roles := map[string]auth.PermissionMatrix{
		"tools only":      {"alpha": {"ai.tool.*"}, "prod": {"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete", "resource.pod.exec"}},
		"configmaps":      {"alpha": {"ai.tool.*", "resource.configmap.read", "resource.configmap.create", "resource.configmap.edit", "resource.configmap.delete"}},
		"deployment edit": {"alpha": {"ai.tool.*", "resource.deployment.edit"}},
		"pod read":        {"alpha": {"ai.tool.*", "resource.pod.read"}},
		"every edit":      {"alpha": {"ai.tool.*", "resource.*.edit"}},
		"every delete":    {"alpha": {"ai.tool.*", "resource.*.delete"}},
	}
	cm := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n"
	cases := []struct {
		name string
		tool string
		args args
		may  []string
	}{
		{"read a list", "k8s_get_resources", args{"resource_type": "configmaps"}, []string{"tools only", "configmaps", "deployment edit", "pod read", "every edit", "every delete"}},
		{"read pod logs", "k8s_get_pod_logs", args{"pod_name": "web"}, []string{"pod read"}},
		{"read helm releases", "helm_read", args{}, nil},
		{"read node logs", "nodes_log", args{"node": "n1"}, nil},
		{"delete a configmap", "k8s_delete_resource", args{"resource_type": "configmap", "resource_name": "x"}, []string{"configmaps", "every delete"}},
		{"delete a secret", "k8s_delete_resource", args{"resource_type": "secret", "resource_name": "x"}, []string{"every delete"}},
		{"delete a configmap and a secret", "k8s_delete_resource", args{"resource_type": "configmap,secret", "resource_name": "x"}, []string{"every delete"}},
		{"delete everything", "k8s_delete_resource", args{"resource_type": "all", "all": true}, []string{"every delete"}},
		{"scale a deployment", "k8s_scale", args{"resource_type": "deployments.apps", "resource_name": "x", "replicas": 2}, []string{"deployment edit", "every edit"}},
		{"patch a configmap", "k8s_patch_resource", args{"resource_type": "cm", "resource_name": "x"}, []string{"configmaps", "every edit"}},
		{"label a node", "k8s_label_resource", args{"resource_type": "no", "resource_name": "x"}, []string{"every edit"}},
		{"restart a deployment", "k8s_rollout", args{"action": "restart", "resource_type": "deploy", "resource_name": "x"}, []string{"deployment edit", "every edit"}},
		{"read a rollout", "k8s_rollout", args{"action": "status", "resource_type": "deploy", "resource_name": "x"}, []string{"tools only", "configmaps", "deployment edit", "pod read", "every edit", "every delete"}},
		{"apply a configmap", "k8s_apply_manifest", args{"yaml_content": cm}, []string{"configmaps", "every edit"}},
		{"apply a configmap and a secret", "k8s_apply_manifest", args{"yaml_content": cm + "---\n" + secret}, []string{"every edit"}},
		{"create a configmap", "k8s_create_resource", args{"yaml_content": cm}, []string{"configmaps"}},
		{"create a secret", "k8s_create_resource", args{"yaml_content": secret}, nil},
		{"preview a secret", "k8s_diff", args{"yaml_content": secret}, []string{"every edit"}},
	}
	for _, c := range cases {
		may := map[string]bool{}
		for _, name := range c.may {
			may[name] = true
		}
		for name, matrix := range roles {
			v := fakeValidator{payload: auth.TokenPayload{Perms: matrix}}
			_, status, err := authorizeToolCall(v, hdr("t"), c.tool, "alpha", c.args)
			if may[name] && status != 0 {
				t.Errorf("%s, role %q: status %d (%v), want allowed", c.name, name, status, err)
			}
			if !may[name] && status != http.StatusForbidden {
				t.Errorf("%s, role %q: status %d, want 403", c.name, name, status)
			}
		}
	}
}

// The seeded Read role's list (auth-service repository_schema.go).
func readRolePerms() []string {
	return append([]string{"resource.*.read", "resource.helm.read", "resource.pod.logfile", "ai.mcp.use"}, aiToolPerms(readRoleTools)...)
}

func aiToolPerms(tools []string) []string {
	out := make([]string, 0, len(tools))
	for _, tool := range tools {
		out = append(out, "ai.tool."+tool)
	}
	return out
}

// Written out as a rule, not read from the table: Write holds every call but what is Admin-only on the screens.
func writeRoleHolds(c screenCase) bool {
	for _, perm := range c.Want {
		if perm == "resource.pod.exec" || perm == "resource.workload.rollback" || perm == "resource.alert.investigate" || perm == "resource.hygiene.scan" || strings.HasPrefix(perm, "admin.") {
			return false
		}
	}
	return true
}

func readRoleHolds(c screenCase) bool {
	for _, tool := range readRoleTools {
		if tool == c.Tool {
			return true
		}
	}
	return false
}

// What the built-in roles and the global admin may call does not move: Admin everything, Write all but Admin-only, Read its read tools.
func TestAuthorizeToolCall_TheBuiltInRolesKeepWhatTheyHad(t *testing.T) {
	check := func(role string, matrix auth.PermissionMatrix, c screenCase, allowed bool) {
		t.Helper()
		v := fakeValidator{payload: auth.TokenPayload{Perms: matrix}}
		_, status, err := authorizeToolCall(v, hdr("t"), c.Tool, "alpha", c.Args)
		if allowed && status != 0 {
			t.Errorf("%s: %s %v: status %d (%v), want allowed", role, c.Tool, c.Args, status, err)
		}
		if !allowed && status != http.StatusForbidden {
			t.Errorf("%s: %s %v: status %d, want 403", role, c.Tool, c.Args, status)
		}
	}
	for _, c := range screenPermissionCases() {
		check("global admin", auth.PermissionMatrix{"*": {"*"}}, c, true)
		check("Admin", auth.PermissionMatrix{"alpha": {"*"}}, c, true)
		check("Write", auth.PermissionMatrix{"alpha": writeRolePerms}, c, writeRoleHolds(c))
		check("Read", auth.PermissionMatrix{"alpha": readRolePerms()}, c, readRoleHolds(c))
	}
}

func TestAuthorizeToolCall_TheOtherClustersGrantDoesNotCount(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{
		"alpha": {"ai.tool.*"},
		"prod":  {"resource.secret.delete", "resource.pod.read"},
	}}}
	for _, c := range []struct {
		tool string
		args args
	}{
		{"k8s_delete_resource", args{"resource_type": "secret", "resource_name": "x"}},
		{"k8s_get_pod_logs", args{"pod_name": "web"}},
	} {
		if _, status, _ := authorizeToolCall(v, hdr("t"), c.tool, "alpha", c.args); status != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", c.tool, status)
		}
		if _, status, err := authorizeToolCall(v, hdr("t"), c.tool, "prod", c.args); status == 0 {
			t.Errorf("%s on prod: allowed without the tool there (%v)", c.tool, err)
		}
	}
}

// Every missing permission is named, in one answer, with the cluster.
func TestAuthorizeToolCall_TheRefusalNamesEveryMissingPermission(t *testing.T) {
	v := fakeValidator{payload: auth.TokenPayload{Perms: auth.PermissionMatrix{"alpha": {"ai.tool.*", "resource.configmap.delete"}}}}
	_, status, err := authorizeToolCall(v, hdr("t"), "k8s_delete_resource", "alpha", args{"resource_type": "configmap,secret,pods", "resource_name": "x"})
	if status != http.StatusForbidden || !errors.Is(err, errForbidden) {
		t.Fatalf("status %d err %v", status, err)
	}
	for _, want := range []string{"resource.secret.delete", "resource.pod.delete", "alpha"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not name %s", err, want)
		}
	}
	if strings.Contains(err.Error(), "resource.configmap.delete") {
		t.Errorf("refusal %q names what the role holds", err)
	}
}

// A refused call never reaches kubectl, and the answer says why.
func TestHandleCall_ARefusedCallDoesNotRunAndSaysWhy(t *testing.T) {
	prev := toolAuth
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"prod": {"ai.tool.*"}}}}
	defer func() { toolAuth = prev }()
	ran := false
	tool := ToolDefinition{Handler: func(context.Context, map[string]interface{}, http.Header) (string, error) {
		ran = true
		return "", nil
	}}
	tools := map[string]ToolDefinition{"k8s_delete_resource": tool, "k8s_get_pod_logs": tool}
	for _, c := range []struct{ body, want string }{
		{`{"name":"k8s_delete_resource","arguments":{"cluster":"prod","resource_type":"secrets","resource_name":"x"}}`, "resource.secret.delete"},
		{`{"name":"k8s_get_pod_logs","arguments":{"cluster":"prod","pod_name":"web"}}`, "resource.pod.read"},
	} {
		req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(c.body))
		req.Header.Set("Authorization", "Bearer t")
		rec := httptest.NewRecorder()
		handleCall(rec, req, tools)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), c.want) || ran {
			t.Errorf("%s: status %d body %s ran=%v, want 403 naming %s", c.body, rec.Code, rec.Body.String(), ran, c.want)
		}
	}
}

// kubectl apply also creates what is not there. On the screens that is the create permission; the edit permission only
// changes what exists.
func TestApply_CreatingWhatIsNotThereNeedsTheCreatePermission(t *testing.T) {
	cm := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: shop\n"
	secret := "apiVersion: v1\nkind: Secret\nmetadata:\n  name: b\n"
	widget := "apiVersion: example.com/v1\nkind: Widget\nmetadata:\n  name: w\n  namespace: shop\n"
	missing := func() (string, error) { return kubectlErr(`Error from server (NotFound): configmaps "a" not found`) }
	refused := func() (string, error) {
		return kubectlErr(`Error from server (Forbidden): configmaps "a" is forbidden: User "u" cannot get resource`)
	}
	found := func() (string, error) { return "configmap/a", nil }
	edit := []string{"ai.tool.*", "resource.*.edit"}
	both := []string{"ai.tool.*", "resource.*.edit", "resource.*.create"}
	cases := []struct {
		name     string
		perms    []string
		manifest string
		get      func() (string, error)
		wantGets []string
		wantRun  bool
	}{
		{"edit: the object is there", edit, cm, found, []string{"get ConfigMap a -o name -n shop"}, true},
		{"edit: the object is not there", edit, cm, missing, []string{"get ConfigMap a -o name -n shop"}, false},
		{"edit: the cluster does not say", edit, cm, refused, []string{"get ConfigMap a -o name -n shop"}, false},
		{"edit: a custom resource is read by its group", edit, widget, found, []string{"get Widget.example.com w -o name -n shop"}, true},
		{"edit: no namespace is kubectl's default, as for the apply", edit, secret, found, []string{"get Secret b -o name"}, true},
		{"edit: a name the server makes up is always new", edit, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  generateName: a-\n", found, nil, false},
		{"edit: no name to look for", edit, "apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n", found, nil, false},
		{"edit: every document is looked for", edit, cm + "---\n" + secret, found, []string{"get ConfigMap a -o name -n shop", "get Secret b -o name"}, true},
		{"edit: a list's items are looked for", edit, "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: Secret\n  metadata:\n    name: b\n", found, []string{"get Secret b -o name"}, true},
		{"edit and create: nothing to look for", both, cm + "---\n" + secret, missing, nil, true},
		{"the Write role: nothing to look for", writeRolePerms, cm, missing, nil, true},
		{"create of this kind only: the other is looked for", []string{"ai.tool.*", "resource.*.edit", "resource.configmap.create"}, cm + "---\n" + secret, found, []string{"get Secret b -o name"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gets []string
			ran := false
			prev := kubectlExec
			kubectlExec = func(_ context.Context, argv []string, _ *string) ([]byte, error) {
				if has(argv, "get") {
					gets = append(gets, strings.Join(verb(argv), " "))
					out, err := c.get()
					return []byte(out), err
				}
				ran = ran || has(argv, "apply")
				return []byte("applied"), nil
			}
			defer func() { kubectlExec = prev }()
			ctx := auth.WithPayload(ctxFor("c1"), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c1": c.perms}})
			_, err := handleApplyManifest(ctx, args{"yaml_content": c.manifest}, bearer())
			if !reflect.DeepEqual(gets, c.wantGets) {
				t.Errorf("looked up %v, want %v", gets, c.wantGets)
			}
			if ran != c.wantRun {
				t.Errorf("applied = %v, want %v (err %v)", ran, c.wantRun, err)
			}
			if !c.wantRun && (!errors.Is(err, errForbidden) || !strings.Contains(err.Error(), ".create")) {
				t.Errorf("err %v, want a refusal naming the create permission", err)
			}
		})
	}
}

// The handler's refusal is a 403 like the others, so the caller does not read it as a broken server.
func TestHandleCall_ARefusalFromTheHandlerIsA403(t *testing.T) {
	resetKubeconfigCache()
	_, restore := mockK8sService(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"kubeconfig":"","in_cluster":true}`))
	})
	defer restore()
	prev, prevApproval := toolAuth, writeApprovalRequired
	toolAuth = fakeValidator{payload: auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"prod": {"ai.tool.*", "resource.*.edit"}}}}
	writeApprovalRequired = false
	defer func() { toolAuth, writeApprovalRequired = prev, prevApproval }()
	prevExec := kubectlExec
	kubectlExec = func(context.Context, []string, *string) ([]byte, error) {
		out, err := kubectlErr(`Error from server (NotFound): configmaps "a" not found`)
		return []byte(out), err
	}
	defer func() { kubectlExec = prevExec }()
	body := `{"name":"k8s_apply_manifest","arguments":{"cluster":"prod","yaml_content":"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n"}}`
	req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer t")
	rec := httptest.NewRecorder()
	handleCall(rec, req, map[string]ToolDefinition{"k8s_apply_manifest": {Handler: handleApplyManifest}})
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "resource.configmap.create") {
		t.Fatalf("status %d body %s, want 403 naming resource.configmap.create", rec.Code, rec.Body.String())
	}
}

// Both services read this one file.
func TestToolScreenCasesFixture(t *testing.T) {
	names := toolScreenTableNames()
	sort.Strings(names)
	spellings := map[string]string{}
	for name, forms := range resourceSpellings {
		spellings[name] = name
		for _, form := range forms {
			spellings[form] = name
		}
	}
	type fixtureCase struct {
		screenCase
		Write bool `json:"write"`
		Read  bool `json:"read"`
	}
	var cases []fixtureCase
	for _, c := range screenPermissionCases() {
		cases = append(cases, fixtureCase{c, writeRoleHolds(c), readRoleHolds(c)})
	}
	fixture := struct {
		Tools     []string          `json:"tools"`
		Spellings map[string]string `json:"spellings"`
		Names     []string          `json:"permission_names"`
		Write     []string          `json:"write_role"`
		Read      []string          `json:"read_role"`
		Cases     []fixtureCase     `json:"cases"`
	}{names, spellings, auth.PermResourceNames(), writeRolePerms, readRolePerms(), cases}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(fixture); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_TOOL_PERMISSION_CASES") == "1" {
		if err := os.WriteFile(toolScreenCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(toolScreenCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_TOOL_PERMISSION_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("tool_screen_permission_cases.json is not these cases: rerun with UPDATE_TOOL_PERMISSION_CASES=1")
	}
}
