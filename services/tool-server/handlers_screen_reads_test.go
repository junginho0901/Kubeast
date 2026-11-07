package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The route's answers here are the JSON the routes write; each tool's answer is compared with them value for value.

func jsonUnmarshalString(s string, into interface{}) error { return json.Unmarshal([]byte(s), into) }

func toolError(ctx context.Context, name string, a map[string]interface{}) error {
	tool, ok := buildToolRegistry()[name]
	if !ok {
		return fmt.Errorf("%s is not a tool", name)
	}
	_, err := tool.Handler(ctx, a, bearer())
	return err
}

func sameValues(t *testing.T, got map[string]interface{}, route string, keys ...string) {
	t.Helper()
	want := decode(t, route)
	if len(keys) == 0 {
		for key := range want {
			keys = append(keys, key)
		}
	}
	for _, key := range keys {
		if !reflect.DeepEqual(got[key], want[key]) {
			t.Errorf("%s: tool %v, route %v", key, got[key], want[key])
		}
	}
}

const podRBACRoute = `{"pod_name":"web-1","namespace":"shop","service_account_name":"web-sa","service_account_labels":{"app":"web"},"secrets":["web-sa-token"],
 "bindings":[{"binding_type":"RoleBinding","binding_name":"web-rb","role_kind":"Role","role_name":"web-reader"},
 {"binding_type":"ClusterRoleBinding","binding_name":"web-crb","role_kind":"ClusterRole","role_name":"view"}]}`

func TestPodRBAC_AnswersWhatItsRouteAnswers(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, podRBACRoute })
	out := runTool(t, ctxFor("c1"), "pod_rbac", args{"namespace": "shop", "pod_name": "web-1"})

	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/namespaces/shop/pods/web-1/rbac" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL.Path)
	}
	if req.URL.Query().Get("cluster") != "c1" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("not asked as the caller: %s auth=%q", req.URL.RawQuery, req.Header.Get("Authorization"))
	}
	got := decode(t, out)
	sameValues(t, got, podRBACRoute)
	// The route names the roles, not their rules: the answer says where the rules are.
	if note, _ := got["note"].(string); !strings.Contains(note, "k8s_describe_resource") {
		t.Errorf("note: %v", got["note"])
	}
}

func TestPodRBAC_RefusalsAreResultsAndArgumentsAreAsked(t *testing.T) {
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"detail":"rolebindings.rbac.authorization.k8s.io is forbidden"}`, "forbidden"},
		{404, `{"detail":"get pod shop/web-9: pods \"web-9\" not found"}`, "not_found"},
	} {
		fakeK8sService(t, func(*http.Request) (int, string) { return c.status, c.body })
		out := runTool(t, ctxFor("c1"), "pod_rbac", args{"namespace": "shop", "pod_name": "web-9"})
		if decode(t, out)["status"] != c.want {
			t.Errorf("%d: %s, want %s", c.status, out, c.want)
		}
	}
	for _, a := range []map[string]interface{}{{"namespace": "shop"}, {"pod_name": "web-1"}} {
		if err := toolError(ctxFor("c1"), "pod_rbac", a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", a, err)
		}
	}
}

const (
	logFileListRoute    = `{"files":[{"path":"/var/log/app/access.log"},{"path":"/var/log/app/app.log"}],"patterns":["/var/log/app/*.log"],"max_lines":2000}`
	logFileContentRoute = `{"container":"app","path":"/var/log/app/app.log","lines":3,"content":"one\ntwo\nthree\n","truncated":false}`
)

func TestLogFiles_WithoutAPathListsWhatTheTabLists(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, logFileListRoute })
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "container": "app"})
	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/namespaces/shop/pods/web-1/logfiles" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL.Path)
	}
	if q := req.URL.Query(); q.Get("container") != "app" || q.Get("cluster") != "c1" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s auth=%q", req.URL.RawQuery, req.Header.Get("Authorization"))
	}
	sameValues(t, decode(t, out), logFileListRoute)
}

func TestLogFiles_WithAPathReadsTheLastLinesThroughTheTabsRoute(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, logFileContentRoute })
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "container": "app", "path": "/var/log/app/app.log", "lines": 3})
	req := (*seen)[0]
	// One read and no stream: the route's fixed tail, which ends at once and records its row.
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/namespaces/shop/pods/web-1/logfiles/content" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL.Path)
	}
	q := req.URL.Query()
	if q.Get("path") != "/var/log/app/app.log" || q.Get("lines") != "3" || q.Get("container") != "app" || q.Get("cluster") != "c1" {
		t.Fatalf("query: %s", req.URL.RawQuery)
	}
	sameValues(t, decode(t, out), logFileContentRoute)
	// The lines come last, so a cut at the model's limit keeps what says what they are.
	if strings.Index(out, `"content"`) < strings.Index(out, `"truncated"`) {
		t.Errorf("content before truncated: %s", out)
	}
}

func TestLogFiles_ReadsAFixedNumberOfLines(t *testing.T) {
	for _, c := range []struct {
		lines interface{}
		want  string
	}{{nil, "50"}, {0, "50"}, {-3, "50"}, {7, "7"}, {2000, "2000"}, {2001, "2000"}, {100000, "2000"}} {
		seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, logFileContentRoute })
		a := args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"}
		if c.lines != nil {
			a["lines"] = c.lines
		}
		runTool(t, ctxFor("c1"), "logfiles", a)
		if got := (*seen)[0].URL.Query().Get("lines"); got != c.want {
			t.Errorf("lines %v: asked %s, want %s", c.lines, got, c.want)
		}
	}
}

func TestLogFiles_ARefusalKeepsTheTabsReason(t *testing.T) {
	for _, c := range []struct {
		status int
		reason string
		detail string
		want   string
	}{
		{404, "disabled", "log files are not enabled", "unavailable"},
		{403, "namespace", `log files are not enabled in namespace "shop"`, "forbidden"},
		{403, "forbidden", "Kubernetes refused pods/exec for your account in this namespace", "forbidden"},
		{400, "path", "path is not covered by the configured log file patterns", "forbidden"},
		{404, "not_found", "pod or container not found", "not_found"},
		{404, "no_file", "file not found", "not_found"},
		{422, "tool_missing", "this container has no tail or ls, so its files cannot be read", "failed"},
		{422, "unreadable", "the container user cannot read this file", "failed"},
		{422, "failed", "tail: read error", "failed"},
	} {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return c.status, `{"detail":` + strconv.Quote(c.detail) + `,"reason":"` + c.reason + `"}`
		})
		out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"})
		got := decode(t, out)
		if got["status"] != c.want || got["reason"] != c.detail {
			t.Errorf("%s: %s, want status %s", c.reason, out, c.want)
		}
		if c.want != "unavailable" && got["code"] != c.reason {
			t.Errorf("%s: code %v", c.reason, got["code"])
		}
	}
	// Past the permission check the route refuses a read it cannot record, and answers the same way here.
	fakeK8sService(t, func(*http.Request) (int, string) { return 503, `{"detail":"audit unavailable"}` })
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"})
	if decode(t, out)["status"] != "audit_unavailable" {
		t.Errorf("503: %s", out)
	}
	fakeK8sService(t, func(*http.Request) (int, string) { return 403, `{"detail":"requires resource.pod.logfile permission"}` })
	out = runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1"})
	if m := decode(t, out); m["status"] != "forbidden" || !strings.Contains(m["reason"].(string), "resource.pod.logfile") {
		t.Errorf("no reason from the route: %s", out)
	}
	for _, a := range []map[string]interface{}{{"namespace": "shop"}, {"pod_name": "web-1"}} {
		if err := toolError(ctxFor("c1"), "logfiles", a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", a, err)
		}
	}
}

func TestLogFiles_AreMaskedAsThePodsLogsAre(t *testing.T) {
	lines := "2026-11-07 start\npassword: fake-log-password\nAuthorization: Bearer fake-log-bearer-value\nurl postgres://admin:fake-log-url-pass@db:5432/x\nthe end\n"
	fakeKubectl(t, func([]string) (string, error) { return lines, nil })
	podLogs, _ := redactToolOutput(runTool(t, ctxFor("c1"), "k8s_get_pod_logs", args{"namespace": "shop", "pod_name": "web-1"}))

	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"container":"app","path":"/var/log/app/app.log","lines":5,"content":` + strconv.Quote(lines) + `,"truncated":false}`
	})
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"})
	masked, stats := redactToolOutput(out)
	if stats == nil || stats.Count == 0 {
		t.Fatalf("nothing masked: %s", masked)
	}
	for _, secret := range []string{"fake-log-password", "fake-log-bearer-value", "fake-log-url-pass"} {
		if strings.Contains(masked, secret) {
			t.Errorf("%s left for the model: %s", secret, masked)
		}
	}
	if got := decode(t, masked)["content"]; got != podLogs {
		t.Errorf("a line reads otherwise than in the pod's logs:\nlog files %q\npod logs  %q", got, podLogs)
	}
	if kept := decode(t, masked); kept["path"] != "/var/log/app/app.log" || kept["lines"] != float64(5) {
		t.Errorf("the masking changed the rest: %s", masked)
	}
}

func TestLogFiles_ALongReadKeepsTheEndOfTheFile(t *testing.T) {
	saved := outputMaxBytes
	outputMaxBytes = 30
	t.Cleanup(func() { outputMaxBytes = saved })
	content := "old line that is cut\nnext line that is cut\nlast line kept\n"
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"container":"app","path":"/var/log/app/app.log","lines":3,"content":` + strconv.Quote(content) + `,"truncated":false}`
	})
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"})
	got := decode(t, out)
	if got["content"] != "last line kept\n" || got["truncated"] != true {
		t.Errorf("content %q truncated %v", got["content"], got["truncated"])
	}
}

func TestLogFiles_AReadLargerThanABodyIsAResult(t *testing.T) {
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"container":"app","path":"/var/log/app/app.log","lines":3,"truncated":true,"content":"` + strings.Repeat("x", featureBodyCap) + `"}`
	})
	out := runTool(t, ctxFor("c1"), "logfiles", args{"namespace": "shop", "pod_name": "web-1", "path": "/var/log/app/app.log"})
	if decode(t, out)["status"] != "failed" {
		t.Errorf("%.200s", out)
	}
}

func TestValidateToolArgs_LogFilePath(t *testing.T) {
	for _, v := range []string{"/var/log/app/app.log", "/var/log/app.2026-11-07.log", "/data/로그/app.log"} {
		if err := validateToolArgs(map[string]interface{}{"path": v}); err != nil {
			t.Errorf("%q should pass: %v", v, err)
		}
	}
	for _, v := range []string{"app.log", "--version", "../etc/passwd", "/var/log/\napp", "/var/log/\x00app", "/" + strings.Repeat("a", 1100)} {
		if err := validateToolArgs(map[string]interface{}{"path": v}); !errors.Is(err, errBadRequest) {
			t.Errorf("%q: %v", v, err)
		}
	}
}

// What the Storage window reads: every claim with its usage, every volume, and the topology.
const (
	pvcsRoute = `[
 {"name":"data-a","namespace":"shop","status":"Bound","volume_name":"pv-a","storage_class":"gp3","capacity":"10Gi","requested":"10Gi","access_modes":["ReadWriteOnce"],"usage":{"used_bytes":5368709120,"capacity_bytes":10737418240,"percent":50,"source":"prometheus"}},
 {"name":"data-b","namespace":"shop","status":"Pending","volume_name":"","storage_class":"gp3","capacity":"","requested":"5Gi","access_modes":[],"usage":null},
 {"name":"logs","namespace":"web","status":"Lost","volume_name":"pv-c","storage_class":"gp3","capacity":"1Gi","requested":"1Gi","access_modes":["ReadWriteOnce"]},
 {"name":"cache","namespace":"web","status":"Bound","volume_name":"pv-d","storage_class":"gp3","capacity":"2Gi","requested":"2Gi","access_modes":["ReadWriteOnce"]}]`
	pvsRoute = `[
 {"name":"pv-a","status":"Bound","capacity":"10Gi","storage_class":"gp3","reclaim_policy":"Delete","claim_ref":{"namespace":"shop","name":"data-a"}},
 {"name":"pv-free","status":"Available","capacity":"3Gi","storage_class":"gp3","reclaim_policy":"Retain","claim_ref":null},
 {"name":"pv-c","status":"Failed","capacity":"1Gi","storage_class":"gp3","reclaim_policy":"Delete","claim_ref":{"namespace":"web","name":"logs"}},
 {"name":"pv-d","status":"Bound","capacity":"2Gi","storage_class":"gp3","reclaim_policy":"Delete","claim_ref":{"namespace":"web","name":"cache"}}]`
	storageTopologyRoute = `{"nodes":[{"id":"pv-pv-a","type":"pv","name":"pv-a"},{"id":"pv-pv-free","type":"pv","name":"pv-free"},{"id":"pv-pv-c","type":"pv","name":"pv-c"},{"id":"pv-pv-d","type":"pv","name":"pv-d"},
 {"id":"pvc-shop-data-a","type":"pvc","name":"data-a","namespace":"shop"},{"id":"pvc-shop-data-b","type":"pvc","name":"data-b","namespace":"shop"},{"id":"pvc-web-logs","type":"pvc","name":"logs","namespace":"web"},{"id":"pvc-web-cache","type":"pvc","name":"cache","namespace":"web"}],
 "edges":[{"id":"edge-1","source":"pvc-shop-data-a","target":"pv-pv-a","type":"bound-to","label":"bound to"},{"id":"edge-2","source":"pvc-web-logs","target":"pv-pv-c","type":"bound-to","label":"bound to"},{"id":"edge-3","source":"pvc-web-cache","target":"pv-pv-d","type":"bound-to","label":"bound to"}],
 "metadata":{"pv_count":4,"pvc_count":4}}`
)

func fakeStorageRoutes(t *testing.T, refuse ...string) *[]*http.Request {
	return fakeK8sService(t, func(r *http.Request) (int, string) {
		for _, path := range refuse {
			if r.URL.Path == path {
				return 403, `{"detail":"` + strings.TrimPrefix(path, "/api/v1/") + ` is forbidden"}`
			}
		}
		switch r.URL.Path {
		case "/api/v1/pvcs":
			return 200, pvcsRoute
		case "/api/v1/pvs":
			return 200, pvsRoute
		case "/api/v1/topology/storage":
			return 200, storageTopologyRoute
		}
		return 404, `{"detail":"no such route"}`
	})
}

func namesOf(t *testing.T, rows interface{}) []string {
	t.Helper()
	list, ok := rows.([]interface{})
	if !ok {
		t.Fatalf("not a list: %v", rows)
	}
	names := make([]string, 0, len(list))
	for _, row := range list {
		names = append(names, fmt.Sprint(row.(map[string]interface{})["name"]))
	}
	return names
}

func TestStorageSummary_CountsWhatTheStorageWindowCounts(t *testing.T) {
	seen := fakeStorageRoutes(t)
	out := runTool(t, ctxFor("c1"), "storage_summary", args{})
	asked := map[string]string{}
	for _, r := range *seen {
		if r.Method != http.MethodGet || r.URL.Query().Get("cluster") != "c1" || r.Header.Get("Authorization") != "Bearer user-token" {
			t.Errorf("%s %s auth=%q", r.Method, r.URL, r.Header.Get("Authorization"))
		}
		asked[r.URL.Path] = r.URL.Query().Get("usage")
	}
	if !reflect.DeepEqual(asked, map[string]string{"/api/v1/pvcs": "true", "/api/v1/pvs": "", "/api/v1/topology/storage": ""}) {
		t.Fatalf("asked %v", asked)
	}
	got := decode(t, out)
	want := map[string]interface{}{
		"pvcs_total": float64(4), "pvs_total": float64(4), "namespace": "all namespaces",
		"pvc_status_counts": map[string]interface{}{"Bound": float64(2), "Pending": float64(1), "Lost": float64(1)},
		"pv_status_counts":  map[string]interface{}{"Bound": float64(2), "Available": float64(1), "Failed": float64(1)},
	}
	for key, value := range want {
		if !reflect.DeepEqual(got[key], value) {
			t.Errorf("%s: %v, want %v", key, got[key], value)
		}
	}
	topology := got["topology"].(map[string]interface{})
	route := decode(t, storageTopologyRoute)
	if topology["pv_count"] != float64(4) || topology["pvc_count"] != float64(4) || topology["nodes_total"] != float64(8) || topology["edges_total"] != float64(3) {
		t.Errorf("topology: %v", topology)
	}
	if !reflect.DeepEqual(topology["edges"], route["edges"]) {
		t.Errorf("edges: %v, route %v", topology["edges"], route["edges"])
	}
	// The window's order: what needs a person first.
	if names := namesOf(t, got["pvcs"]); !reflect.DeepEqual(names, []string{"data-b", "logs", "data-a", "cache"}) {
		t.Errorf("claims in the order %v", names)
	}
	if names := namesOf(t, got["pvs"]); !reflect.DeepEqual(names, []string{"pv-c", "pv-free", "pv-a", "pv-d"}) {
		t.Errorf("volumes in the order %v", names)
	}
	// A row is the route's row, usage included.
	var routeRows []interface{}
	if err := jsonUnmarshalString(pvcsRoute, &routeRows); err != nil {
		t.Fatal(err)
	}
	var first map[string]interface{}
	for _, row := range got["pvcs"].([]interface{}) {
		if row.(map[string]interface{})["name"] == "data-a" {
			first = row.(map[string]interface{})
		}
	}
	if !reflect.DeepEqual(first, routeRows[0]) {
		t.Errorf("row: %v\nroute: %v", first, routeRows[0])
	}
	// No total capacity: the window does not compute one, so a tool's number could not be held to it.
	for _, key := range []string{"total_capacity", "capacity_total"} {
		if _, ok := got[key]; ok {
			t.Errorf("%s is no value of the window", key)
		}
	}
}

func TestStorageSummary_ANamespaceNarrowsAsTheWindowsFilterDoes(t *testing.T) {
	fakeStorageRoutes(t)
	got := decode(t, runTool(t, ctxFor("c1"), "storage_summary", args{"namespace": "shop"}))
	if got["namespace"] != "shop" || got["pvcs_total"] != float64(2) || got["pvs_total"] != float64(1) {
		t.Fatalf("%v", got)
	}
	if names := namesOf(t, got["pvs"]); !reflect.DeepEqual(names, []string{"pv-a"}) {
		t.Errorf("volumes: %v", names)
	}
	if !reflect.DeepEqual(got["pvc_status_counts"], map[string]interface{}{"Bound": float64(1), "Pending": float64(1)}) {
		t.Errorf("counts: %v", got["pvc_status_counts"])
	}
}

func TestStorageSummary_APartTheClusterRefusesIsSaidAndTheRestStands(t *testing.T) {
	fakeStorageRoutes(t, "/api/v1/pvs", "/api/v1/topology/storage")
	got := decode(t, runTool(t, ctxFor("c1"), "storage_summary", args{}))
	if got["pvcs_total"] != float64(4) {
		t.Errorf("claims: %v", got)
	}
	if _, ok := got["pvs"]; ok {
		t.Errorf("volumes that could not be read: %v", got["pvs"])
	}
	if _, ok := got["pvs_total"]; ok {
		t.Errorf("a count of volumes that could not be read: %v", got["pvs_total"])
	}
	if !strings.Contains(fmt.Sprint(got["pvs_error"]), "forbidden") || !strings.Contains(fmt.Sprint(got["topology_error"]), "forbidden") {
		t.Errorf("errors: %v / %v", got["pvs_error"], got["topology_error"])
	}
	fakeStorageRoutes(t, "/api/v1/pvcs")
	if got := decode(t, runTool(t, ctxFor("c1"), "storage_summary", args{})); got["status"] != "forbidden" {
		t.Errorf("no claims: %v", got)
	}
}

func TestStorageSummary_ALimitedGrantSeesItsClaimsOnly(t *testing.T) {
	fakeStorageRoutes(t, "/api/v1/pvs", "/api/v1/topology/storage")
	out := runTool(t, ctxFor("c1", "shop"), "storage_summary", args{})
	got := decode(t, out)
	if got["pvcs_total"] != float64(2) || strings.Contains(out, `"web"`) || strings.Contains(out, "logs") {
		t.Errorf("%s", out)
	}
	if !reflect.DeepEqual(got["namespace"], []interface{}{"shop"}) {
		t.Errorf("namespace: %v", got["namespace"])
	}
}

const netpolEffectiveRoute = `{"kind":"Pod","namespace":"shop","name":"web-1","host_network":false,
 "ingress":{"isolated":true,"policies":[{"name":"allow-front","rules":[{"peers":[{"pod_selector":"app=front"}],"ports":[{"protocol":"TCP","port":"8080"}]}]}]},
 "egress":{"isolated":false,"policies":[]},"unevaluated":[{"kind":"CiliumNetworkPolicy","group":"cilium.io","count":1}]}`

func TestNetworkPolicyEffective_AnswersWhatThePodsSectionAnswers(t *testing.T) {
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, netpolEffectiveRoute })
	out := runTool(t, ctxFor("c1"), "network_policy_effective", args{"namespace": "shop", "pod": "web-1"})
	req := (*seen)[0]
	if req.URL.Path != "/api/v1/namespaces/shop/networkpolicies/effective" || req.URL.Query().Get("kind") != "Pod" || req.URL.Query().Get("name") != "web-1" || req.URL.Query().Get("cluster") != "c1" {
		t.Fatalf("%s?%s", req.URL.Path, req.URL.RawQuery)
	}
	sameValues(t, decode(t, out), netpolEffectiveRoute)

	seen = fakeK8sService(t, func(*http.Request) (int, string) { return 200, netpolEffectiveRoute })
	runTool(t, ctxFor("c1"), "network_policy_effective", args{"namespace": "shop", "workload_kind": "Deployment", "workload_name": "web"})
	if q := (*seen)[0].URL.Query(); q.Get("kind") != "Deployment" || q.Get("name") != "web" {
		t.Errorf("workload: %s", (*seen)[0].URL.RawQuery)
	}
	for _, a := range []map[string]interface{}{{"namespace": "shop"}, {"pod": "web-1"}, {"namespace": "shop", "pod": "a", "workload_kind": "Deployment", "workload_name": "b"}} {
		if err := toolError(ctxFor("c1"), "network_policy_effective", a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", a, err)
		}
	}
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 403, `{"detail":"requires resource.networkpolicy.read permission"}`
	})
	if m := decode(t, runTool(t, ctxFor("c1"), "network_policy_effective", args{"namespace": "shop", "pod": "web-1"})); m["status"] != "forbidden" {
		t.Errorf("%v", m)
	}
}

func TestLimitRangeViolations_AnswersWhatTheWindowLists(t *testing.T) {
	route := `[{"pod":"web-1","namespace":"shop","container":"app","field":"cpu max","actual":"4","limit":"2"},
 {"pod":"web-1","namespace":"shop","container":"app","field":"memory min (unset)","actual":"(none)","limit":"128Mi"}]`
	seen := fakeK8sService(t, func(*http.Request) (int, string) { return 200, route })
	got := decode(t, runTool(t, ctxFor("c1"), "limit_range_violations", args{"namespace": "shop", "name": "limits"}))
	if (*seen)[0].URL.Path != "/api/v1/namespaces/shop/limitranges/limits/violations" || (*seen)[0].URL.Query().Get("cluster") != "c1" {
		t.Fatalf("%s", (*seen)[0].URL)
	}
	var rows []interface{}
	if err := jsonUnmarshalString(route, &rows); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got["violations"], rows) || got["violations_total"] != float64(2) || got["namespace"] != "shop" || got["name"] != "limits" {
		t.Errorf("%v", got)
	}

	fakeK8sService(t, func(*http.Request) (int, string) { return 200, `[]` })
	got = decode(t, runTool(t, ctxFor("c1"), "limit_range_violations", args{"namespace": "shop", "name": "limits"}))
	if got["violations_total"] != float64(0) || !reflect.DeepEqual(got["violations"], []interface{}{}) {
		t.Errorf("none: %v", got)
	}
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 404, `{"detail":"get limit range shop/x: limitranges \"x\" not found"}`
	})
	if m := decode(t, runTool(t, ctxFor("c1"), "limit_range_violations", args{"namespace": "shop", "name": "x"})); m["status"] != "not_found" {
		t.Errorf("%v", m)
	}
	for _, a := range []map[string]interface{}{{"namespace": "shop"}, {"name": "limits"}} {
		if err := toolError(ctxFor("c1"), "limit_range_violations", a); !errors.Is(err, errBadRequest) {
			t.Errorf("%v: %v", a, err)
		}
	}
}

const (
	inboxReadRow   = `{"id":"a1","cluster":"c1","fingerprint":"f1","alertname":"HighLoad","severity":"page","namespace":"shop","labels":{"pod":"web-1"},"summary":"load is high","status":"firing","starts_at":"2026-11-07T00:00:00Z","resolved_at":null,"first_received_at":"2026-11-07T00:00:00Z","last_received_at":"2026-11-07T00:10:00Z","received_count":2,"acknowledged":true,"acked_by":"ops@example.com","acked_at":"2026-11-07T00:05:00Z","assignee":"ops@example.com","done":false,"done_by":"","done_at":null,"investigation":null}`
	inboxListRoute = `{"items":[` + inboxReadRow + `],"total":41,"counts":{"firing":3,"stale":1,"resolved":37},"limit":20,"offset":40,"stale_hours":24,"severities":["critical","page"]}`
	inboxOneRoute  = `{"id":"a1","cluster":"c1","fingerprint":"f1","alertname":"HighLoad","severity":"page","namespace":"shop","labels":{"pod":"web-1"},"summary":"load is high","status":"firing","acknowledged":true,"acked_by":"ops@example.com","assignee":"ops@example.com","done":false,"done_by":"","investigation":null,
 "annotations":{"summary":"load is high","runbook":"https://runbook.example/load"},"generator_url":"http://prom/graph","alertmanager_url":"http://am","receiver":"kubeast","note":"looking at the node","note_by":"ops@example.com","note_at":"2026-11-07T00:06:00Z",
 "investigate_now":{"permission":"resource.alert.investigate","allowed":false,"reason":"forbidden","until":null,"automatic":false,"budget":0,"used":0}}`
)

func TestAlertsInbox_ListsWhatTheInboxLists(t *testing.T) {
	seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, inboxListRoute })
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"status": "firing", "alert_severity": "page", "mine": true, "open_only": true, "search": "load", "limit": 20, "offset": 40})
	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/alerts/inbox" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL)
	}
	q := req.URL.Query()
	for key, want := range map[string]string{"cluster": "c1", "status": "firing", "severity": "page", "mine": "true", "open": "true", "q": "load", "limit": "20", "offset": "40"} {
		if q.Get(key) != want {
			t.Errorf("%s=%q, want %q", key, q.Get(key), want)
		}
	}
	sameValues(t, decode(t, out), inboxListRoute, "items", "total", "counts", "limit", "offset", "stale_hours", "severities")
	// The summary leads, so a cut at the model's limit keeps the counts.
	if strings.Index(out, `"items"`) < strings.Index(out, `"total"`) {
		t.Errorf("items before the counts: %.200s", out)
	}
}

func TestAlertsInbox_AsksForAPageTheRouteTakes(t *testing.T) {
	for _, c := range []struct {
		limit interface{}
		want  string
	}{{nil, "50"}, {0, "50"}, {-1, "50"}, {200, "200"}, {5000, "200"}} {
		seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, inboxListRoute })
		a := args{}
		if c.limit != nil {
			a["limit"] = c.limit
		}
		runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", a)
		q := (*seen)[0].URL.Query()
		if q.Get("limit") != c.want || q.Has("mine") || q.Has("open") || q.Has("q") || q.Has("status") || q.Has("severity") {
			t.Errorf("limit %v: %s", c.limit, (*seen)[0].URL.RawQuery)
		}
	}
	// The route takes 200 characters; past them this says so instead of a 422.
	if err := toolError(ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"search": strings.Repeat("x", 201)}); !errors.Is(err, errBadRequest) {
		t.Errorf("a long search: %v", err)
	}
}

func TestAlertsInbox_OneAlertReadsTheWindowWithItsMarksAndNote(t *testing.T) {
	seen := fakeAIService(t, func(*http.Request) (int, string) { return 200, inboxOneRoute })
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1"})
	req := (*seen)[0]
	if len(*seen) != 1 || req.Method != http.MethodGet || req.URL.Path != "/api/v1/alerts/inbox/a1" {
		t.Fatalf("%d requests, first %s %s", len(*seen), req.Method, req.URL.Path)
	}
	got := decode(t, out)
	sameValues(t, got, inboxOneRoute)
	if !strings.Contains(fmt.Sprint(got["alert_link"]), "alert=a1") {
		t.Errorf("alert_link: %v", got["alert_link"])
	}
	// The marks lead, so a cut at the model's limit keeps them.
	if strings.Index(out, `"annotations"`) < strings.Index(out, `"note"`) {
		t.Errorf("annotations before the note: %.300s", out)
	}
}

func TestAlertsInbox_AnotherClustersAlertIsNotRead(t *testing.T) {
	fakeAIService(t, func(*http.Request) (int, string) {
		return 200, strings.Replace(inboxOneRoute, `"cluster":"c1"`, `"cluster":"other"`, 1)
	})
	out := runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a1"})
	if decode(t, out)["status"] != "not_found" || strings.Contains(out, "looking at the node") {
		t.Errorf("%s", out)
	}
}

func TestAlertsInbox_ARefusalIsAResult(t *testing.T) {
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{404, `{"detail":"the alert inbox is off (features.alertInvestigation.enabled)"}`, "unavailable"},
		{403, `{"detail":"the alert inbox needs resource.pod.read on the whole cluster"}`, "forbidden"},
	} {
		fakeAIService(t, func(*http.Request) (int, string) { return c.status, c.body })
		if m := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{})); m["status"] != c.want {
			t.Errorf("%d: %v", c.status, m)
		}
	}
	fakeAIService(t, func(*http.Request) (int, string) { return 404, `{"detail":"alert not found"}` })
	if m := decode(t, runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"alert_id": "a9"})); m["status"] != "not_found" {
		t.Errorf("%v", m)
	}
	fakeAIService(t, func(*http.Request) (int, string) {
		return 400, `{"detail":"status must be one of ['firing', 'stale', 'resolved']"}`
	})
	if err := toolError(ctxWithPayload("c1", holderOf()), "alerts_inbox", args{"status": "nope"}); !errors.Is(err, errBadRequest) {
		t.Errorf("a wrong status: %v", err)
	}
}

// No filter of the inbox and no id can be turned into a press or a mark: every call is a GET.
func TestAlertsInbox_NeverChangesAnything(t *testing.T) {
	seen := fakeAIService(t, func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/inbox") {
			return 200, inboxListRoute
		}
		return 200, inboxOneRoute
	})
	for _, a := range []map[string]interface{}{{}, {"alert_id": "a1"}, {"alert_id": "a1", "note": "x", "acknowledged": true, "assignee": "me", "done": true}} {
		runTool(t, ctxWithPayload("c1", holderOf()), "alerts_inbox", a)
	}
	for _, r := range *seen {
		if r.Method != http.MethodGet {
			t.Errorf("%s %s", r.Method, r.URL)
		}
	}
}

func TestValidateToolArgs_InboxSeverityIsNotTheThreeWordsOfTheOtherTools(t *testing.T) {
	// A severity here is what the alert carries, for example page.
	for _, v := range []string{"page", "critical", "P1 high"} {
		if err := validateToolArgs(map[string]interface{}{"alert_severity": v}); err != nil {
			t.Errorf("%q: %v", v, err)
		}
	}
	for _, v := range []string{"a\nb", strings.Repeat("x", 51)} {
		if err := validateToolArgs(map[string]interface{}{"alert_severity": v}); !errors.Is(err, errBadRequest) {
			t.Errorf("%q: %v", v, err)
		}
	}
}

// The tools a limited grant calls without naming a namespace, each fed a value outside the grant.
func TestALimitedGrantCallsWithoutANamespaceAndSeesNothingOutsideIt(t *testing.T) {
	const outside = "outside-the-grant"
	ctx := ctxFor("c1", "shop")

	t.Run("issues", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, `{"window_minutes":60,"generated_at":"2026-11-07T00:00:00Z","issues":[
 {"namespace":"shop","severity":"warning","kind":"Pod","name":"web-1"},
 {"namespace":"` + outside + `","severity":"critical","kind":"Pod","name":"` + outside + `-pod"},
 {"namespace":"","severity":"critical","kind":"Node","name":"` + outside + `-node"},
 {"severity":"info","kind":"Collector","name":"nodes","reason":"ListFailed","message":"nodes is forbidden"}]}`
		})
		out := runTool(t, ctx, "issues", args{})
		got := decode(t, out)
		if strings.Contains(out, outside) || got["total"] != float64(2) {
			t.Errorf("%s", out)
		}
		if !reflect.DeepEqual(got["counts"], map[string]interface{}{"critical": float64(0), "warning": float64(1), "info": float64(1)}) {
			t.Errorf("counts: %v", got["counts"])
		}
		// The screen says which list it could not read, so the answer does not read as the whole cluster being fine.
		if !strings.Contains(out, "nodes is forbidden") {
			t.Errorf("the unread list is not said: %s", out)
		}
		// A namespace named is that namespace's issues.
		named := decode(t, runTool(t, ctx, "issues", args{"namespace": "shop"}))
		if named["total"] != float64(1) {
			t.Errorf("named: %v", named)
		}
	})

	t.Run("cost", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, `{"window":"24h","aggregate":"namespace","scoped":true,"rows":[{"namespace":"shop","name":"shop","total_cost":1},{"namespace":"` + outside + `","name":"` + outside + `","total_cost":99}],"totals":{"total_cost":1}}`
		})
		out := runTool(t, ctx, "cost", args{})
		if strings.Contains(out, outside) || decode(t, out)["rows_total"] != float64(1) {
			t.Errorf("%s", out)
		}
	})

	t.Run("k8s_find_resource", func(t *testing.T) {
		fakeK8sService(t, func(*http.Request) (int, string) {
			return 200, `{"total":2,"items":[{"namespace":"shop","name":"web-1"},{"namespace":"` + outside + `","name":"web-` + outside + `"}]}`
		})
		calls := fakeKubectl(t, func(a []string) (string, error) {
			if has(a, "namespaces") {
				return "<none> shop map[]\n<none> web-" + outside + " map[]\n", nil
			}
			return "shop web map[]\n" + outside + " web-" + outside + " map[]\n", nil
		})
		for _, kinds := range [][]string{{"pods"}, {"services"}, {"namespaces"}} {
			out := runTool(t, ctx, "k8s_find_resource", args{"query": "web", "kinds": kinds})
			if strings.Contains(out, outside) {
				t.Errorf("%v: %s", kinds, out)
			}
		}
		for _, call := range *calls {
			if has(call, "--all-namespaces") {
				t.Errorf("widened: %v", call)
			}
		}
		// What the grant reaches is still found.
		out := runTool(t, ctx, "k8s_find_resource", args{"query": "web", "kinds": []string{"services"}})
		if m := decode(t, out); len(m["matches"].([]interface{})) != 1 {
			t.Errorf("%s", out)
		}
	})

	t.Run("gitops_status", func(t *testing.T) {
		calls := fakeKubectl(t, func(a []string) (string, error) {
			return `{"apiVersion":"v1","kind":"List","items":[{"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"web","namespace":"shop"},"spec":{"project":"shop","destination":{"namespace":"shop"}},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}]}`, nil
		})
		out := runTool(t, ctx, "gitops_status", args{})
		got := decode(t, out)
		if got["applications_total"] != float64(1) || got["matched"] != float64(1) || !reflect.DeepEqual(got["scope"], []interface{}{"shop"}) {
			t.Errorf("%s", out)
		}
		if len(*calls) != 1 || strings.Join(verb((*calls)[0]), " ") != "get applications.argoproj.io -n shop -o json" {
			t.Errorf("argv: %v", *calls)
		}
	})

	t.Run("k8s_explain", func(t *testing.T) {
		fakeKubectl(t, func(a []string) (string, error) { return "KIND: Pod\nFIELDS:\n", nil })
		if out := runTool(t, ctx, "k8s_explain", args{"resource": "pods"}); !strings.Contains(out, "KIND: Pod") {
			t.Errorf("%s", out)
		}
	})
}

// Several granted namespaces are read one by one; one that the cluster refuses is said and the others stand.
func TestGitopsStatus_ALimitedGrantReadsEachOfItsNamespaces(t *testing.T) {
	app := func(ns, name string) string {
		return `{"apiVersion":"argoproj.io/v1alpha1","kind":"Application","metadata":{"name":"` + name + `","namespace":"` + ns + `"},"spec":{"project":"p"},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}}`
	}
	calls := fakeKubectl(t, func(a []string) (string, error) {
		switch {
		case has(a, "shop"):
			return `{"apiVersion":"v1","kind":"List","items":[` + app("shop", "web") + `]}`, nil
		case has(a, "web"):
			return kubectlErr(`Error from server (Forbidden): applications.argoproj.io is forbidden: User "r@x" cannot list resource "applications" in API group "argoproj.io" in the namespace "web"`)
		}
		return `{"apiVersion":"v1","kind":"List","items":[` + app("api", "svc") + `]}`, nil
	})
	got := decode(t, runTool(t, ctxFor("c1", "shop", "web", "api"), "gitops_status", args{}))
	if len(*calls) != 3 || got["applications_total"] != float64(2) || got["matched"] != float64(2) {
		t.Fatalf("%d calls: %v", len(*calls), got)
	}
	if notes := fmt.Sprint(got["notes"]); !strings.Contains(notes, "web") {
		t.Errorf("notes: %s", notes)
	}

	// None of them readable: the refusal itself, as for one namespace.
	fakeKubectl(t, func([]string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): applications.argoproj.io is forbidden: User "r@x" cannot list resource "applications"`)
	})
	if got := decode(t, runTool(t, ctxFor("c1", "shop", "web"), "gitops_status", args{})); got["status"] != "forbidden" {
		t.Errorf("all refused: %v", got)
	}
	// The kind is missing from the cluster: one answer, whichever namespace saw it first.
	calls = fakeKubectl(t, func([]string) (string, error) {
		return kubectlErr(`error: the server doesn't have a resource type "applications"`)
	})
	if got := decode(t, runTool(t, ctxFor("c1", "shop", "web"), "gitops_status", args{})); got["status"] != "unavailable" {
		t.Errorf("no kind: %v", got)
	}
	for _, call := range *calls {
		if has(call, "web") {
			t.Errorf("asked again after the kind was missing: %v", call)
		}
	}
	// Naming one of them reads that one.
	calls = fakeKubectl(t, func([]string) (string, error) {
		return `{"apiVersion":"v1","kind":"List","items":[` + app("shop", "web") + `]}`, nil
	})
	got = decode(t, runTool(t, ctxFor("c1", "shop", "web"), "gitops_status", args{"namespace": "shop"}))
	if len(*calls) != 1 || got["scope"] != "shop" {
		t.Errorf("%d calls: %v", len(*calls), got)
	}
}
