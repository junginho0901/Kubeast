package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func fakeAuthService(t *testing.T, respond func(r *http.Request) (int, string)) *[]*http.Request {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		status, body := respond(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	orig := authServiceURL
	authServiceURL = srv.URL
	t.Cleanup(func() { authServiceURL = orig; srv.Close() })
	return &seen
}

const auditReply = `{"total":3,"items":[
 {"ID":41,"CreatedAt":"2026-10-16T01:00:00Z","Service":"k8s","Action":"k8s.pod.delete","ActorUserID":"u1","ActorEmail":"ops@x","TargetID":"web-1","TargetType":"pod","Cluster":"c1","Namespace":"shop","Before":{"replicas":2,"token":"***"},"After":null,"Result":"success","Error":"","RequestIP":"10.0.0.9","UserAgent":"curl","RequestID":"r1","Path":"/api/v1/pods/web-1"},
 {"ID":40,"CreatedAt":"2026-10-16T00:59:00Z","Service":"ai","Action":"ai.tool.execute","ActorEmail":"bot@x","TargetID":"k8s_scale_resource","Cluster":"c1","Result":"failure","Error":"forbidden"}
]}`

func TestAuditSearch_FiltersCondenseAndRefusals(t *testing.T) {
	seen := fakeAuthService(t, func(r *http.Request) (int, string) { return 200, auditReply })
	out, err := handleAuditSearch(ctxFor("c1"), map[string]interface{}{"audit_action": "k8s.pod.delete", "actor_email": "ops@x", "result": "success", "since_time": "24h", "until_time": "2026-10-16T02:00:00Z", "limit": 2}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	q := req.URL.Query()
	if req.URL.Path != "/api/v1/auth/admin/audit-logs" || req.Header.Get("Authorization") != "Bearer user-token" {
		t.Fatalf("request: %s %s", req.URL.Path, req.Header.Get("Authorization"))
	}
	if q.Get("action") != "k8s.pod.delete" || q.Get("actor_email") != "ops@x" || q.Get("result") != "success" || q.Get("cluster") != "c1" || q.Get("limit") != "2" || q.Get("until") != "2026-10-16T02:00:00Z" {
		t.Fatalf("query: %s", req.URL.RawQuery)
	}
	since, perr := time.Parse(time.RFC3339, q.Get("since"))
	if perr != nil || time.Since(since) < 23*time.Hour || time.Since(since) > 25*time.Hour {
		t.Fatalf("since from 24h: %q", q.Get("since"))
	}
	m := decode(t, out)
	if m["total"] != float64(3) || m["returned"] != float64(2) || m["cluster"] != "c1" || !strings.Contains(m["hint"].(string), "offset=2") {
		t.Fatalf("totals: %s", out)
	}
	entries := m["entries"].([]interface{})
	first := entries[0].(map[string]interface{})
	if first["id"] != float64(41) || first["at"] != "2026-10-16T01:00:00Z" || first["action"] != "k8s.pod.delete" || first["actor"] != "ops@x" || first["namespace"] != "shop" || first["result"] != "success" {
		t.Fatalf("entry: %v", first)
	}
	if first["target"].(map[string]interface{})["id"] != "web-1" || first["before"] != `{"replicas":2,"token":"***"}` {
		t.Fatalf("target/before: %v", first)
	}
	for _, dropped := range []string{"after", "user_agent", "request_id", "UserAgent"} {
		if _, has := first[dropped]; has {
			t.Fatalf("%s should not be in the answer: %v", dropped, first)
		}
	}
	second := entries[1].(map[string]interface{})
	if second["result"] != "failure" || second["error"] != "forbidden" || second["actor"] != "bot@x" {
		t.Fatalf("failure entry: %v", second)
	}

	// Every cluster: no cluster filter; a long before/after is cut.
	long := `{"total":1,"items":[{"ID":1,"CreatedAt":"t","Action":"a.b.c","After":{"manifest":"` + strings.Repeat("x", 900) + `"}}]}`
	seen = fakeAuthService(t, func(r *http.Request) (int, string) { return 200, long })
	out, _ = handleAuditSearch(ctxFor("c1"), map[string]interface{}{"all_clusters": true, "offset": 5}, bearer())
	if (*seen)[0].URL.Query().Has("cluster") || (*seen)[0].URL.Query().Get("offset") != "5" || (*seen)[0].URL.Query().Get("limit") != "50" {
		t.Fatalf("all_clusters query: %s", (*seen)[0].URL.RawQuery)
	}
	m = decode(t, out)
	after := m["entries"].([]interface{})[0].(map[string]interface{})["after"].(string)
	if m["cluster"] != "all" || len(after) > auditDetailCap+3 || !strings.HasSuffix(after, "…") {
		t.Fatalf("cut: %d %v", len(after), m["cluster"])
	}

	// Kubeast-wide actions carry no cluster: an empty cluster-filtered answer points at all_clusters.
	fakeAuthService(t, func(r *http.Request) (int, string) { return 200, `{"total":0,"items":[]}` })
	out, _ = handleAuditSearch(ctxFor("c1"), map[string]interface{}{"audit_action": "admin.audit.read"}, bearer())
	if m := decode(t, out); m["returned"] != float64(0) || !strings.Contains(m["hint"].(string), "all_clusters=true") {
		t.Fatalf("empty hint: %s", out)
	}

	fakeAuthService(t, func(r *http.Request) (int, string) { return 403, `{"detail":"permission denied: admin.audit.read"}` })
	out, err = handleAuditSearch(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "forbidden" {
		t.Fatalf("403 is a forbidden result: %s", out)
	}
	if _, err := handleAuditSearch(ctxFor("c1"), map[string]interface{}{"since_time": "yesterday"}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("bad from: %v", err)
	}
	for _, args := range []map[string]interface{}{{"audit_action": "k8s.pod.delete"}, {"audit_action": "ai.*"}, {"since_time": "7d"}, {"since_time": "2026-10-16T00:00:00Z"}, {"until_time": "2026-10-16T00:00:00+09:00"}, {"result": "failure"}, {"actor_email": "a@b.c"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{{"audit_action": "K8s Pod"}, {"since_time": "91d"}, {"since_time": "last week"}, {"until_time": "today"}, {"result": "ok"}, {"target_id": "a\nb"}} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
	scoped := auth.TokenPayload{Perms: auth.PermissionMatrix{"c": {"ai.tool.*"}}, Namespaces: map[string][]string{"c": {"shop"}}}
	for _, tool := range []string{"audit_search", "nodes_stats_summary", "nodes_log"} {
		if err := namespaceGate(scoped, "c", tool, map[string]interface{}{}); !errors.Is(err, errNamespaceScope) {
			t.Errorf("%s spans the cluster: %v", tool, err)
		}
	}
}

const statsSummary = `{"node":{"nodeName":"n1","startTime":"2026-10-05T04:00:04Z",
 "systemContainers":[{"name":"kubelet","cpu":{"usageNanoCores":150000000},"memory":{"workingSetBytes":209715200}},{"name":"pods","cpu":{"usageNanoCores":2500000000},"memory":{"workingSetBytes":4294967296}}],
 "cpu":{"usageNanoCores":3140000000,"psi":{"full":{"avg10":0.5,"avg60":0.2,"avg300":0.1,"total":1},"some":{"avg10":1.5,"avg60":0.9,"avg300":0.4,"total":2}}},
 "memory":{"availableBytes":2147483648,"usageBytes":6442450944,"workingSetBytes":5368709120,"rssBytes":4294967296,"psi":{"full":{"avg10":0,"avg60":0,"avg300":0,"total":0}}},
 "network":{"name":"eth0","rxBytes":1073741824,"rxErrors":0,"txBytes":536870912,"txErrors":2},
 "fs":{"availableBytes":53687091200,"capacityBytes":107374182400,"usedBytes":53687091200,"inodesFree":900000,"inodes":1000000,"inodesUsed":100000},
 "runtime":{"imageFs":{"availableBytes":53687091200,"capacityBytes":107374182400,"usedBytes":10737418240}},
 "rlimit":{"maxpid":4194304,"curproc":812},
 "swap":{"swapAvailableBytes":0,"swapUsageBytes":0}},
 "pods":[
  {"podRef":{"name":"web-1","namespace":"shop"},"containers":[{"name":"web"},{"name":"sidecar"}],"cpu":{"usageNanoCores":500000000},"memory":{"workingSetBytes":1073741824},"ephemeral-storage":{"usedBytes":10485760},"process_stats":{"process_count":9}},
  {"podRef":{"name":"db-0","namespace":"shop"},"containers":[{"name":"db"}],"cpu":{"usageNanoCores":100000000},"memory":{"workingSetBytes":2147483648},"ephemeral-storage":{"usedBytes":524288000}},
  {"podRef":{"name":"job-x","namespace":"batch"},"containers":[{"name":"j"}],"cpu":{"usageNanoCores":900000000},"memory":{"workingSetBytes":52428800},"ephemeral-storage":{"usedBytes":1048576}}
 ]}`

func TestNodesStatsSummary_OneNodeAllNodesAndFailures(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "--raw") {
			return statsSummary, nil
		}
		return "n1\nn2\n", nil
	})
	out, err := handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{"node": "n1", "top": 2}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	if v := verb((*calls)[0]); strings.Join(v, " ") != "get --raw /api/v1/nodes/n1/proxy/stats/summary" {
		t.Fatalf("argv: %v", v)
	}
	m := decode(t, out)
	if m["node"] != "n1" || m["cpu_cores"] != 3.14 || m["memory_mib"].(map[string]interface{})["working_set"] != float64(5120) || m["memory_mib"].(map[string]interface{})["available"] != float64(2048) {
		t.Fatalf("node: %s", out)
	}
	if m["fs"].(map[string]interface{})["used_gib"] != float64(50) || m["image_fs"].(map[string]interface{})["used_gib"] != float64(10) || m["network"].(map[string]interface{})["tx_errors"] != float64(2) {
		t.Fatalf("fs/network: %s", out)
	}
	if m["psi"].(map[string]interface{})["cpu"].(map[string]interface{})["some_avg10"] != 1.5 || m["rlimit"].(map[string]interface{})["processes"] != float64(812) {
		t.Fatalf("psi/rlimit: %s", out)
	}
	if m["system_containers"].(map[string]interface{})["kubelet"].(map[string]interface{})["memory_working_set_mib"] != float64(200) {
		t.Fatalf("system containers: %s", out)
	}
	pods := m["pods_top"].([]interface{})
	if m["pods_total"] != float64(3) || len(pods) != 2 || pods[0].(map[string]interface{})["name"] != "db-0" || pods[1].(map[string]interface{})["name"] != "web-1" {
		t.Fatalf("top by memory: %s", out)
	}
	if pods[1].(map[string]interface{})["containers"] != float64(2) || pods[1].(map[string]interface{})["processes"] != float64(9) || pods[1].(map[string]interface{})["cpu_cores"] != 0.5 {
		t.Fatalf("pod row: %v", pods[1])
	}

	fakeKubectl(t, func(args []string) (string, error) { return statsSummary, nil })
	out, _ = handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{"node": "n1", "rank_by": "cpu", "top": 1}, bearer())
	if pods := decode(t, out)["pods_top"].([]interface{}); len(pods) != 1 || pods[0].(map[string]interface{})["name"] != "job-x" {
		t.Fatalf("top by cpu: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) { return statsSummary, nil })
	out, _ = handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{"node": "n1", "rank_by": "ephemeral_storage", "top": 1}, bearer())
	if pods := decode(t, out)["pods_top"].([]interface{}); pods[0].(map[string]interface{})["name"] != "db-0" {
		t.Fatalf("top by ephemeral storage: %s", out)
	}

	// No node: every node at node level, no pods.
	calls = fakeKubectl(t, func(args []string) (string, error) {
		if has(args, "--raw") {
			if has(args, "/api/v1/nodes/n2/proxy/stats/summary") {
				return kubectlErr(`Error from server: error trying to reach service: dial tcp 10.0.0.2:10250: connect: connection refused`)
			}
			return statsSummary, nil
		}
		return "n1\nn2\n", nil
	})
	out, err = handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	m = decode(t, out)
	nodes := m["nodes"].([]interface{})
	if m["nodes_total"] != float64(2) || len(nodes) != 2 || len(*calls) != 3 {
		t.Fatalf("all nodes: %s", out)
	}
	if n1 := nodes[0].(map[string]interface{}); n1["node"] != "n1" || n1["cpu_cores"] != 3.14 || n1["pods_top"] != nil {
		t.Fatalf("n1: %v", n1)
	}
	if n2 := nodes[1].(map[string]interface{}); n2["status"] != "unavailable" || !strings.Contains(n2["reason"].(string), "n2") {
		t.Fatalf("unreachable kubelet is reported per node: %v", n2)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (NotFound): nodes "nope" not found`)
	})
	out, _ = handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{"node": "nope"}, bearer())
	if m := decode(t, out); m["status"] != "not_found" {
		t.Fatalf("missing node: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (Forbidden): nodes "n1" is forbidden: User "r@x" cannot get resource "nodes/proxy" in API group "" at the cluster scope`)
	})
	out, _ = handleNodesStatsSummary(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if m := decode(t, out); m["status"] != "forbidden" {
		t.Fatalf("forbidden: %s", out)
	}
	for _, args := range []map[string]interface{}{{"node": "ip-10-0-0-1.ec2.internal"}, {"rank_by": "cpu"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{{"node": "--all"}, {"rank_by": "disk"}} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
}

func TestNodesLog_QueryListingAndFailures(t *testing.T) {
	calls := fakeKubectl(t, func(args []string) (string, error) {
		return "Oct 16 01:00:00 n1 kubelet[812]: I1016 01:00:00.000 ready\nOct 16 01:00:01 n1 kubelet[812]: E1016 01:00:01.000 oops\n", nil
	})
	out, err := handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "n1", "pattern": "E1016", "tail_lines": 50, "since_time": "1h", "boot": -1}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	raw := verb((*calls)[0])[2]
	if !strings.HasPrefix(raw, "/api/v1/nodes/n1/proxy/logs/?") || !strings.Contains(raw, "query=kubelet") || !strings.Contains(raw, "tailLines=50") || !strings.Contains(raw, "pattern=E1016") || !strings.Contains(raw, "sinceTime=") || !strings.Contains(raw, "boot=-1") {
		t.Fatalf("raw path: %s", raw)
	}
	m := decode(t, out)
	if m["node"] != "n1" || m["source"] != "kubelet" || m["lines_returned"] != float64(2) || !strings.Contains(m["text"].(string), "oops") {
		t.Fatalf("lines: %s", out)
	}

	fakeKubectl(t, func(args []string) (string, error) {
		return "<!doctype html>\n<meta name=\"viewport\" content=\"width=device-width\">\n<pre>\n<a href=\"containers/\">containers/</a>\n</pre>\n", nil
	})
	out, _ = handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "n1", "source": "containerd"}, bearer())
	if m := decode(t, out); m["status"] != "unavailable" || !strings.Contains(m["reason"].(string), "enableSystemLogQuery") {
		t.Fatalf("file listing means the query is off: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (NotFound): the server could not find the requested resource`)
	})
	out, _ = handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "n1"}, bearer())
	if m := decode(t, out); m["status"] != "unavailable" || !strings.Contains(m["reason"].(string), "enableSystemLogHandler") {
		t.Fatalf("no /logs/ handler: %s", out)
	}
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (NotFound): nodes "nope" not found`)
	})
	out, _ = handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "nope"}, bearer())
	if m := decode(t, out); m["status"] != "not_found" {
		t.Fatalf("missing node: %s", out)
	}
	if _, err := handleNodesLog(ctxFor("c1"), map[string]interface{}{}, bearer()); !errors.Is(err, errBadRequest) {
		t.Fatalf("node required: %v", err)
	}
	for _, args := range []map[string]interface{}{{"source": "kubelet"}, {"source": "/var/log/kubelet.log"}, {"pattern": "level=error"}} {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	for _, args := range []map[string]interface{}{{"source": "../etc/passwd"}, {"source": "a b"}, {"pattern": "x\ny"}} {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused: %v", args, err)
		}
	}
}
