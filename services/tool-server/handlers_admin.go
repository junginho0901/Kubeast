// Admin-only tools: the audit log through auth-service, and node internals
// (kubelet stats summary, node logs) through the API server proxy as the
// user. ai-service offers them only to a token holding admin.audit.read /
// admin.nodes.read; the cluster's RBAC (nodes/proxy) and auth-service's own
// permission check stand behind that.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var authServiceURL = envOrDefault("AUTH_SERVICE_URL", "http://auth-service:8004")

const (
	auditItemsDefault = 50
	auditItemsCap     = 200
	auditDetailCap    = 500
	auditAlternative  = "The audit log is read through auth-service (permission admin.audit.read). Use k8s_get_events for what the cluster itself recorded."

	nodesTopDefault     = 10
	nodesTopCap         = 20
	nodesListCap        = 20
	nodeLogLinesDefault = 200
	nodeLogLinesCap     = 1000
	nodeLogTextCap      = 64 << 10
	nodesAlternative    = "get_node_metrics for current usage from metrics-server, k8s_describe_resource on the node for conditions, k8s_get_events for node events."
)

var fromDurationRe = regexp.MustCompile(`^([0-9]+)(m|h|d)$`)

// parseFromTime reads a relative window (15m, 24h, 30d; at most 90d) or an
// RFC3339 instant.
func parseFromTime(v string, now time.Time) (time.Time, error) {
	if m := fromDurationRe.FindStringSubmatch(v); m != nil {
		n, _ := strconv.Atoi(m[1])
		unit := map[string]time.Duration{"m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
		d := time.Duration(n) * unit
		if d <= 0 || d > 90*24*time.Hour {
			return time.Time{}, fmt.Errorf("a window between 1m and 90d")
		}
		return now.Add(-d), nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("a window such as 24h or 7d, or an RFC3339 time")
	}
	return t, nil
}

// authServiceGet calls auth-service with the user's own Authorization header;
// auth-service applies its permission check and writes its own audit entry.
func authServiceGet(ctx context.Context, headers http.Header, path string, q url.Values) (int, []byte, error) {
	target := authServiceURL + "/api/v1/auth" + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	if auth := headers.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := featureHTTP.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("auth-service %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, featureBodyCap))
	if err != nil {
		return 0, nil, fmt.Errorf("auth-service %s: %w", path, err)
	}
	return resp.StatusCode, body, nil
}

// handleAuditSearch: GET /api/v1/auth/admin/audit-logs with the filters the
// model gave, condensed to one line per entry (before/after cut to 500 chars).
func handleAuditSearch(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	filter := map[string]interface{}{}
	if v := argString(args, "audit_action", ""); v != "" {
		q.Set("action", v)
		filter["action"] = v
	}
	for _, k := range []string{"service", "actor_email", "target_id", "namespace", "result"} {
		if v := argString(args, k, ""); v != "" {
			q.Set(k, v)
			filter[k] = v
		}
	}
	cluster := clusterIDFromCtx(ctx)
	if argBool(args, "all_clusters") {
		cluster = "all"
	} else {
		q.Set("cluster", cluster)
	}
	now := time.Now()
	if v := argString(args, "since_time", ""); v != "" {
		t, err := parseFromTime(v, now)
		if err != nil {
			return "", wrapBadRequest("since_time: " + err.Error())
		}
		q.Set("since", t.UTC().Format(time.RFC3339))
		filter["since"] = t.UTC().Format(time.RFC3339)
	}
	if v := argString(args, "until_time", ""); v != "" {
		q.Set("until", v)
		filter["until"] = v
	}
	limit := argInt(args, "limit", auditItemsDefault)
	if limit < 1 || limit > auditItemsCap {
		limit = auditItemsCap
	}
	q.Set("limit", strconv.Itoa(limit))
	offset := argInt(args, "offset", 0)
	if offset > 0 {
		q.Set("offset", strconv.Itoa(offset))
	}

	status, body, err := authServiceGet(ctx, headers, "/admin/audit-logs", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("audit_search", auditAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	items, _ := reply["items"].([]interface{})
	entries := make([]map[string]interface{}, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]interface{}); ok {
			entries = append(entries, condenseAuditEntry(m))
		}
	}
	result := map[string]interface{}{
		"cluster":  cluster,
		"filter":   filter,
		"total":    reply["total"],
		"returned": len(entries),
		"offset":   offset,
		"entries":  entries,
	}
	if total, ok := reply["total"].(float64); ok && int(total) > offset+len(entries) {
		result["hint"] = fmt.Sprintf("%d more entries match; narrow the filter or pass offset=%d.", int(total)-offset-len(entries), offset+len(entries))
	}
	if len(entries) == 0 && cluster != "all" {
		result["hint"] = "No entries for cluster " + cluster + " in this window. Kubeast-wide actions (auth.*, admin.*, user and role changes) carry no cluster — pass all_clusters=true for those."
	}
	return marshalJSON(result)
}

// condenseAuditEntry reads auth-service's entry (Go field names) into the
// fields an answer needs; before/after are cut, user agent and request id dropped.
func condenseAuditEntry(m map[string]interface{}) map[string]interface{} {
	pick := func(keys ...string) interface{} {
		for _, k := range keys {
			if v, ok := m[k]; ok && v != nil && v != "" {
				return v
			}
		}
		return nil
	}
	e := map[string]interface{}{
		"id":      pick("ID", "id"),
		"at":      pick("CreatedAt", "created_at"),
		"service": pick("Service", "service"),
		"action":  pick("Action", "action"),
		"actor":   pick("ActorEmail", "actor_email", "ActorUserID", "actor_user_id"),
		"result":  stringOr(pick("Result", "result"), "success"),
	}
	target := map[string]interface{}{}
	for k, keys := range map[string][]string{"type": {"TargetType", "target_type"}, "id": {"TargetID", "target_id"}, "email": {"TargetEmail", "target_email"}} {
		if v := pick(keys...); v != nil {
			target[k] = v
		}
	}
	if len(target) > 0 {
		e["target"] = target
	}
	for k, keys := range map[string][]string{"cluster": {"Cluster", "cluster"}, "namespace": {"Namespace", "namespace"}, "error": {"Error", "error"}, "request_ip": {"RequestIP", "request_ip"}, "path": {"Path", "path"}} {
		if v := pick(keys...); v != nil {
			e[k] = v
		}
	}
	for k, keys := range map[string][]string{"before": {"Before", "before"}, "after": {"After", "after"}} {
		if v := pick(keys...); v != nil {
			raw, _ := json.Marshal(v)
			s := string(raw)
			if s == "null" || s == `""` {
				continue
			}
			if len(s) > auditDetailCap {
				s = s[:auditDetailCap] + "…"
			}
			e[k] = s
		}
	}
	return e
}

// handleNodesStatsSummary: the kubelet Summary API through the API server
// proxy (GET /api/v1/nodes/<node>/proxy/stats/summary), as the user. Without
// node= it reads every node (up to 20) at node level; with node= it adds the
// node's pods ranked by memory, cpu or ephemeral storage.
func handleNodesStatsSummary(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	node := argString(args, "node", "")
	top := argInt(args, "top", nodesTopDefault)
	if top < 1 || top > nodesTopCap {
		top = nodesTopCap
	}
	rank := argString(args, "rank_by", "memory")
	if node == "" {
		out, err := runKubectl(ctx, headers, "get", "nodes", "-o", `jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}`)
		if err != nil {
			if res, ok := failureResult(ctx, headers, err, "Node", "", ""); ok {
				return res, nil
			}
			return "", err
		}
		names := splitLines(strings.TrimSpace(out))
		total := len(names)
		if len(names) > nodesListCap {
			names = names[:nodesListCap]
		}
		nodes := make([]map[string]interface{}, 0, len(names))
		for _, n := range names {
			summary, res, err := fetchStatsSummary(ctx, headers, n)
			switch {
			case err != nil:
				return "", err
			case res != "":
				var failure map[string]interface{}
				_ = json.Unmarshal([]byte(res), &failure)
				nodes = append(nodes, map[string]interface{}{"node": n, "status": failure["status"], "reason": failure["reason"]})
			default:
				nodes = append(nodes, nodeSummary(n, summary))
			}
		}
		result := map[string]interface{}{"nodes_total": total, "nodes": nodes, "hint": "Pass node=<name> for that node's pods ranked by memory, cpu or ephemeral_storage."}
		if total > nodesListCap {
			result["truncated"] = true
		}
		return marshalJSON(result)
	}
	summary, res, err := fetchStatsSummary(ctx, headers, node)
	if err != nil {
		return "", err
	}
	if res != "" {
		return res, nil
	}
	out := nodeSummary(node, summary)
	pods, _ := summary["pods"].([]interface{})
	out["pods_total"] = len(pods)
	out["ranked_by"] = rank
	out["pods_top"] = topPods(pods, rank, top)
	return marshalJSON(out)
}

// fetchStatsSummary returns the decoded summary, or a failure result (not
// found, forbidden, kubelet unreachable) as JSON text.
func fetchStatsSummary(ctx context.Context, headers http.Header, node string) (map[string]interface{}, string, error) {
	out, err := runKubectl(ctx, headers, "get", "--raw", "/api/v1/nodes/"+node+"/proxy/stats/summary")
	if err != nil {
		if res, ok := failureResult(ctx, headers, err, "Node", node, ""); ok {
			return nil, res, nil
		}
		if msg := err.Error(); strings.Contains(msg, "error trying to reach service") || strings.Contains(msg, "connection refused") || strings.Contains(msg, "no route to host") {
			res, rerr := unavailableResult("nodes_stats_summary", fmt.Sprintf("The API server could not reach the kubelet on %s: %s", node, trimKubectlError(msg)), nodesAlternative)
			return nil, res, rerr
		}
		return nil, "", err
	}
	var summary map[string]interface{}
	if err := json.Unmarshal([]byte(out), &summary); err != nil {
		return nil, "", fmt.Errorf("stats summary of %s: unreadable reply: %w", node, err)
	}
	return summary, "", nil
}

func trimKubectlError(msg string) string {
	msg = strings.TrimPrefix(msg, "kubectl failed: ")
	if len(msg) > 300 {
		msg = msg[:300] + "…"
	}
	return msg
}

const (
	mib = 1024 * 1024
	gib = 1024 * mib
)

// numAt walks a JSON object by keys and returns the number found, if any.
func numAt(m map[string]interface{}, path ...string) (float64, bool) {
	var cur interface{} = m
	for _, k := range path {
		obj, ok := cur.(map[string]interface{})
		if !ok {
			return 0, false
		}
		cur, ok = obj[k]
		if !ok {
			return 0, false
		}
	}
	f, ok := cur.(float64)
	return f, ok
}

func mapAt(m map[string]interface{}, path ...string) map[string]interface{} {
	var cur interface{} = m
	for _, k := range path {
		obj, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = obj[k]
	}
	out, _ := cur.(map[string]interface{})
	return out
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

// usageSummary condenses a cpu+memory pair the way the Summary API nests them.
func usageSummary(m map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	if v, ok := numAt(m, "cpu", "usageNanoCores"); ok {
		out["cpu_cores"] = round2(v / 1e9)
	}
	if v, ok := numAt(m, "memory", "workingSetBytes"); ok {
		out["memory_working_set_mib"] = round2(v / mib)
	}
	return out
}

func fsSummary(fs map[string]interface{}) map[string]interface{} {
	if fs == nil {
		return nil
	}
	out := map[string]interface{}{}
	for k, key := range map[string]string{"usedBytes": "used_gib", "capacityBytes": "capacity_gib", "availableBytes": "available_gib"} {
		if v, ok := numAt(fs, k); ok {
			out[key] = round2(v / gib)
		}
	}
	for k, key := range map[string]string{"inodesUsed": "inodes_used", "inodesFree": "inodes_free"} {
		if v, ok := numAt(fs, k); ok {
			out[key] = int64(v)
		}
	}
	return out
}

func psiSummary(m map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, res := range []string{"cpu", "memory", "io"} {
		psi := mapAt(m, res, "psi")
		if psi == nil {
			continue
		}
		p := map[string]interface{}{}
		for _, kind := range []string{"some", "full"} {
			if v, ok := numAt(psi, kind, "avg10"); ok {
				p[kind+"_avg10"] = v
			}
			if v, ok := numAt(psi, kind, "avg60"); ok {
				p[kind+"_avg60"] = v
			}
		}
		if len(p) > 0 {
			out[res] = p
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// nodeSummary condenses the node part of a Summary API reply.
func nodeSummary(name string, summary map[string]interface{}) map[string]interface{} {
	node := mapAt(summary, "node")
	out := map[string]interface{}{"node": name}
	if node == nil {
		return out
	}
	if v, ok := node["startTime"].(string); ok {
		out["since"] = v
	}
	if v, ok := numAt(node, "cpu", "usageNanoCores"); ok {
		out["cpu_cores"] = round2(v / 1e9)
	}
	mem := map[string]interface{}{}
	for k, key := range map[string]string{"workingSetBytes": "working_set", "availableBytes": "available", "usageBytes": "usage", "rssBytes": "rss"} {
		if v, ok := numAt(node, "memory", k); ok {
			mem[key] = round2(v / mib)
		}
	}
	if len(mem) > 0 {
		out["memory_mib"] = mem
	}
	if fs := fsSummary(mapAt(node, "fs")); fs != nil {
		out["fs"] = fs
	}
	if fs := fsSummary(mapAt(node, "runtime", "imageFs")); fs != nil {
		out["image_fs"] = fs
	}
	if net := mapAt(node, "network"); net != nil {
		n := map[string]interface{}{}
		for k, key := range map[string]string{"rxBytes": "rx_mib", "txBytes": "tx_mib"} {
			if v, ok := numAt(net, k); ok {
				n[key] = round2(v / mib)
			}
		}
		for k, key := range map[string]string{"rxErrors": "rx_errors", "txErrors": "tx_errors"} {
			if v, ok := numAt(net, k); ok {
				n[key] = int64(v)
			}
		}
		if len(n) > 0 {
			out["network"] = n
		}
	}
	if sw := mapAt(node, "swap"); sw != nil {
		s := map[string]interface{}{}
		for k, key := range map[string]string{"swapUsageBytes": "usage", "swapAvailableBytes": "available"} {
			if v, ok := numAt(sw, k); ok {
				s[key] = round2(v / mib)
			}
		}
		if len(s) > 0 {
			out["swap_mib"] = s
		}
	}
	if rl := mapAt(node, "rlimit"); rl != nil {
		r := map[string]interface{}{}
		if v, ok := numAt(rl, "curproc"); ok {
			r["processes"] = int64(v)
		}
		if v, ok := numAt(rl, "maxpid"); ok {
			r["max_pid"] = int64(v)
		}
		if len(r) > 0 {
			out["rlimit"] = r
		}
	}
	if psi := psiSummary(node); psi != nil {
		out["psi"] = psi
	}
	if scs, ok := node["systemContainers"].([]interface{}); ok {
		sys := map[string]interface{}{}
		for _, sc := range scs {
			m, _ := sc.(map[string]interface{})
			if n, _ := m["name"].(string); n != "" {
				sys[n] = usageSummary(m)
			}
		}
		if len(sys) > 0 {
			out["system_containers"] = sys
		}
	}
	return out
}

// topPods ranks the pods of a Summary API reply by memory working set, cpu
// or ephemeral storage and keeps the first n.
func topPods(pods []interface{}, rank string, n int) []map[string]interface{} {
	type ranked struct {
		key float64
		pod map[string]interface{}
	}
	list := make([]ranked, 0, len(pods))
	for _, p := range pods {
		m, _ := p.(map[string]interface{})
		if m == nil {
			continue
		}
		ref := mapAt(m, "podRef")
		row := map[string]interface{}{"namespace": ref["namespace"], "name": ref["name"]}
		cpu, _ := numAt(m, "cpu", "usageNanoCores")
		memWS, _ := numAt(m, "memory", "workingSetBytes")
		eph, _ := numAt(m, "ephemeral-storage", "usedBytes")
		row["cpu_cores"] = round2(cpu / 1e9)
		row["memory_working_set_mib"] = round2(memWS / mib)
		row["ephemeral_storage_mib"] = round2(eph / mib)
		if cs, ok := m["containers"].([]interface{}); ok {
			row["containers"] = len(cs)
		}
		if v, ok := numAt(m, "process_stats", "process_count"); ok {
			row["processes"] = int64(v)
		}
		key := memWS
		switch rank {
		case "cpu":
			key = cpu
		case "ephemeral_storage":
			key = eph
		}
		list = append(list, ranked{key, row})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].key > list[j].key })
	if len(list) > n {
		list = list[:n]
	}
	out := make([]map[string]interface{}, 0, len(list))
	for _, r := range list {
		out = append(out, r.pod)
	}
	return out
}

// handleNodesLog: the kubelet log query (GET /api/v1/nodes/<node>/proxy/logs/
// ?query=<service|file>, Kubernetes 1.36+ GA) as the user. A kubelet with the
// query off answers the /var/log file listing instead; that is reported as
// unavailable with what to turn on.
func handleNodesLog(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	node := argString(args, "node", "")
	if node == "" {
		return "", wrapBadRequest("node parameter is required")
	}
	source := argString(args, "source", "kubelet")
	q := url.Values{}
	q.Set("query", source)
	lines := argInt(args, "tail_lines", nodeLogLinesDefault)
	if lines < 1 || lines > nodeLogLinesCap {
		lines = nodeLogLinesCap
	}
	q.Set("tailLines", strconv.Itoa(lines))
	if p := argString(args, "pattern", ""); p != "" {
		q.Set("pattern", p)
	}
	if v := argString(args, "since_time", ""); v != "" {
		t, err := parseFromTime(v, time.Now())
		if err != nil {
			return "", wrapBadRequest("since_time: " + err.Error())
		}
		q.Set("sinceTime", t.UTC().Format(time.RFC3339))
	}
	if v := argString(args, "until_time", ""); v != "" {
		q.Set("untilTime", v)
	}
	if b := argInt(args, "boot", 0); b != 0 {
		q.Set("boot", strconv.Itoa(b))
	}
	out, err := runKubectl(ctx, headers, "get", "--raw", "/api/v1/nodes/"+node+"/proxy/logs/?"+q.Encode())
	if err != nil {
		if res, ok := failureResult(ctx, headers, err, "Node", node, ""); ok {
			return res, nil
		}
		msg := err.Error()
		if strings.Contains(msg, "the server could not find the requested resource") || strings.Contains(msg, "404") {
			return unavailableResult("nodes_log", fmt.Sprintf("The kubelet on %s does not serve /logs/ (enableSystemLogHandler is off).", node), nodesAlternative)
		}
		if strings.Contains(msg, "error trying to reach service") || strings.Contains(msg, "connection refused") {
			return unavailableResult("nodes_log", fmt.Sprintf("The API server could not reach the kubelet on %s: %s", node, trimKubectlError(msg)), nodesAlternative)
		}
		return "", err
	}
	trimmed := strings.TrimSpace(out)
	if strings.HasPrefix(trimmed, "<") {
		return unavailableResult("nodes_log",
			fmt.Sprintf("The kubelet on %s ignores log queries: enableSystemLogQuery is off, so /logs/ only lists files. Set enableSystemLogQuery: true (with enableSystemLogHandler: true) in the kubelet configuration — the NodeLogQuery feature is GA since Kubernetes 1.36.", node),
			nodesAlternative)
	}
	textLines := splitLines(trimmed)
	truncated := false
	if len(trimmed) > nodeLogTextCap {
		trimmed = trimmed[:nodeLogTextCap] + fmt.Sprintf(truncatedMarker, nodeLogTextCap)
		truncated = true
	}
	result := map[string]interface{}{
		"node":           node,
		"source":         source,
		"lines_returned": len(textLines),
		"text":           trimmed,
	}
	if truncated {
		result["truncated"] = true
	}
	if len(textLines) == 0 {
		result["hint"] = "No lines matched. Check the service name (kubelet, containerd, crio) or a file path under /var/log, or widen from/pattern."
	}
	return marshalJSON(result)
}
