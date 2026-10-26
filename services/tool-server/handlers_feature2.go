// More Kubeast features as read tools, on the k8s-service call path of
// handlers_feature.go: the hygiene report (Admin), policy reports, Helm
// releases read-only, cost and optimization, can-i and the resource graph.
// k8s-service keeps its own permission checks, redaction and audit rows.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

const (
	rowsCap             = 200
	helmTextCap         = 64 << 10
	helmValuesCap       = 32 << 10
	graphNodesCap       = 200
	graphEdgesCap       = 400
	hygieneFindCap      = 200
	policyRowsCap       = 200
	netpolChecksCap     = 40
	netflowsGroupsCap   = 50
	netflowsFlowsCap    = 20
	netflowsAlternative = "No Hubble Relay is configured for this cluster (features.networkFlows). Use network_policy_check to see what NetworkPolicy allows, and prometheus_query for drop counters (hubble_drop_total) if Hubble metrics are scraped."
	nfmRowsCap          = 50
	nfmAlternative      = "No Network Flow Monitor monitor is configured for this cluster (features.networkFlowMonitor). Use network_flows where the cluster has a Hubble Relay or Calico's Whisker, and network_drops for drop counts."
	costDefaultWin      = "24h"
	helmDefaultSect     = "values"
	policyDefaultTop    = "summary"
)

// k8sServicePost is k8sServiceGet with a JSON body (the Helm diff).
func k8sServicePost(ctx context.Context, headers http.Header, path string, q url.Values, body interface{}) (int, []byte, error) {
	if q == nil {
		q = url.Values{}
	}
	q.Set("cluster", clusterIDFromCtx(ctx))
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, k8sServiceURL+"/api/v1"+path+"?"+q.Encode(), bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if auth := headers.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := doTraced(featureHTTP, req)
	if err != nil {
		return 0, nil, fmt.Errorf("k8s-service %s: %w", path, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, featureBodyCap))
	if err != nil {
		return 0, nil, fmt.Errorf("k8s-service %s: %w", path, err)
	}
	return resp.StatusCode, out, nil
}

// featureReply decodes a 200 into a map; anything else goes through featureFailure.
func featureReply(feature, alternative string, status int, body []byte) (map[string]interface{}, string, error) {
	if status != http.StatusOK {
		out, ok, err := featureFailure(feature, alternative, status, body)
		if ok {
			return nil, out, nil
		}
		return nil, "", err
	}
	var reply map[string]interface{}
	if err := json.Unmarshal(body, &reply); err != nil {
		return nil, "", fmt.Errorf("%s: unreadable reply: %w", feature, err)
	}
	return reply, "", nil
}

// capList trims reply[key] to n items and records the cut.
func capList(reply map[string]interface{}, key string, n int) {
	items, ok := reply[key].([]interface{})
	if !ok {
		return
	}
	reply[key+"_total"] = len(items)
	if len(items) > n {
		reply[key] = items[:n]
		reply["truncated"] = true
	}
}

// handleHygiene returns the cluster hygiene report (Admin: admin.hygiene.read).
func handleHygiene(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	status, body, err := k8sServiceGet(ctx, headers, "/hygiene", nil)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("hygiene", "The cluster hygiene report is off (features.hygiene.enabled). Use issues for what is failing now and k8s_describe_resource for one object.", status, body)
	if err != nil || out != "" {
		return out, err
	}
	if report, ok := reply["report"].(map[string]interface{}); ok {
		severity := strings.ToLower(argString(args, "severity", ""))
		check := argString(args, "check", "")
		if findings, ok := report["findings"].([]interface{}); ok && (severity != "" || check != "") {
			kept := make([]interface{}, 0, len(findings))
			for _, f := range findings {
				m, _ := f.(map[string]interface{})
				if severity != "" && strings.ToLower(fmt.Sprint(m["severity"])) != severity {
					continue
				}
				if check != "" && fmt.Sprint(m["check"]) != check {
					continue
				}
				kept = append(kept, f)
			}
			report["findings"] = kept
			report["filter"] = map[string]string{"severity": severity, "check": check}
		}
		capList(report, "findings", hygieneFindCap)
	}
	return marshalJSON(reply)
}

// handlePolicyReports: the policy summary (per policy and namespace) or the
// filtered result rows of PolicyReport / ClusterPolicyReport.
func handlePolicyReports(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	view := argString(args, "view", policyDefaultTop)
	q := url.Values{}
	if ns := argString(args, "namespace", ""); ns != "" {
		q.Set("namespace", ns)
	}
	path := "/policyreports/summary"
	if view == "results" {
		path = "/policyreports/results"
		for arg, param := range map[string]string{"policy": "policy", "kind": "kind", "search": "search", "results": "result", "severities": "severity"} {
			if v := strings.TrimSpace(argString(args, arg, "")); v != "" {
				q.Set(param, v)
			}
		}
		limit := argInt(args, "limit", 100)
		if limit <= 0 || limit > policyRowsCap {
			limit = policyRowsCap
		}
		q.Set("limit", strconv.Itoa(limit))
	}
	status, body, err := k8sServiceGet(ctx, headers, path, q)
	if err != nil {
		return "", err
	}
	alt := "No PolicyReport source (Kyverno, Trivy Operator …) on this cluster. Use issues and k8s_describe_resource instead."
	// ListIfServed answers an empty array when the CRD is not served.
	if status == http.StatusOK && bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
		return unavailableResult("policyReports", "the wgpolicyk8s.io PolicyReport API is not served by this cluster", alt)
	}
	reply, out, err := featureReply("policyReports", alt, status, body)
	if err != nil || out != "" {
		return out, err
	}
	reply["view"] = view
	if view == "results" {
		capList(reply, "rows", policyRowsCap)
		if total, _ := reply["total"].(float64); total == 0 {
			reply["hint"] = "No result matched. Widen the filter (results pass,fail,warn,error,skip; drop policy/kind) or check the namespace."
		}
	} else {
		capList(reply, "policies", rowsCap)
		capList(reply, "namespaces", rowsCap)
	}
	return marshalJSON(reply)
}

var helmWhat = map[string]bool{"list": true, "get": true, "values": true, "manifest": true, "notes": true, "hooks": true, "history": true, "resources": true, "images": true, "diff": true, "revision": true}

// handleHelmRead reads Helm releases as the caller (resource.helm.read):
// list, one release, a section, history, resources, images, a revision's
// section, or the diff between two revisions. Never a write — those stay with
// helm_execute and the approval card.
func handleHelmRead(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	what := argString(args, "what", "list")
	if !helmWhat[what] {
		return "", wrapBadRequest("what must be one of list, get, values, manifest, notes, hooks, history, resources, images, diff, revision")
	}
	namespace := argString(args, "namespace", "")
	release := argString(args, "release", "")
	alt := "Helm releases could not be read here. Use k8s_get_resources on the workloads instead."
	if what == "list" {
		q := url.Values{}
		if namespace != "" {
			q.Set("namespace", namespace)
		}
		if s := argString(args, "status", ""); s != "" {
			q.Set("status", s)
		}
		status, body, err := k8sServiceGet(ctx, headers, "/helm/releases", q)
		if err != nil {
			return "", err
		}
		reply, out, err := featureReply("helm", alt, status, body)
		if err != nil || out != "" {
			return out, err
		}
		capList(reply, "items", rowsCap)
		reply["namespace"] = namespaceOrAll(namespace)
		if total, _ := reply["items_total"].(float64); total == 0 {
			reply["hint"] = "No Helm release in that scope. Workloads installed without Helm do not appear here; use k8s_get_resources."
		}
		return marshalJSON(reply)
	}
	if namespace == "" || release == "" {
		return "", wrapBadRequest("namespace and release are required for what=" + what)
	}
	base := "/helm/releases/" + url.PathEscape(namespace) + "/" + url.PathEscape(release)
	section := argString(args, "section", "")
	var status int
	var body []byte
	var err error
	switch what {
	case "get":
		status, body, err = k8sServiceGet(ctx, headers, base, nil)
	case "values", "manifest", "notes", "hooks":
		status, body, err = k8sServiceGet(ctx, headers, base+"/"+what, nil)
	case "history", "resources", "images":
		status, body, err = k8sServiceGet(ctx, headers, base+"/"+what, nil)
	case "revision":
		rev := argInt(args, "revision", 0)
		if rev <= 0 {
			return "", wrapBadRequest("revision (a positive number) is required for what=revision")
		}
		if section == "" {
			section = helmDefaultSect
		}
		status, body, err = k8sServiceGet(ctx, headers, base+"/revisions/"+strconv.Itoa(rev)+"/"+section, nil)
	case "diff":
		from, to := argInt(args, "from", 0), argInt(args, "to", 0)
		if from <= 0 || to <= 0 {
			return "", wrapBadRequest("from and to (revision numbers) are required for what=diff")
		}
		if section == "" {
			section = "manifest"
		}
		status, body, err = k8sServicePost(ctx, headers, base+"/diff", nil, map[string]interface{}{"from": from, "to": to, "section": section})
	}
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("helm", alt, status, body)
	if err != nil || out != "" {
		return out, err
	}
	reply["release"] = release
	reply["namespace"] = namespace
	switch what {
	case "get":
		// The manifest is its own section; values beyond the cap too.
		if _, ok := reply["manifest"]; ok {
			delete(reply, "manifest")
			reply["manifest_note"] = "omitted here — call what=manifest"
		}
		if raw, err := json.Marshal(reply["values"]); err == nil && len(raw) > helmValuesCap {
			delete(reply, "values")
			reply["values_note"] = fmt.Sprintf("values are %d bytes — call what=values", len(raw))
		}
	case "values", "manifest", "notes", "hooks", "revision", "diff":
		for _, key := range []string{"content", "diff"} {
			if text, ok := reply[key].(string); ok && len(text) > helmTextCap {
				reply[key] = text[:helmTextCap] + fmt.Sprintf(truncatedMarker, helmTextCap)
				reply["truncated"] = true
			}
		}
	case "history", "resources", "images":
		capList(reply, "items", rowsCap)
	}
	return marshalJSON(reply)
}

// handleCost: OpenCost allocation by namespace or controller for a window,
// narrowed to a namespace or the caller's granted namespaces.
func handleCost(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	window := argString(args, "window", costDefaultWin)
	aggregate := argString(args, "aggregate", "namespace")
	namespace := argString(args, "namespace", "")
	q := url.Values{"window": {window}, "aggregate": {aggregate}}
	status, body, err := k8sServiceGet(ctx, headers, "/cost", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("cost", "No OpenCost is reachable in this cluster, so costs are unavailable here. Use optimization (requests vs usage) and get_pod_metrics for sizing without prices.", status, body)
	if err != nil || out != "" {
		return out, err
	}
	scope := scopedNamespaces(ctx)
	if rows, ok := reply["rows"].([]interface{}); ok && (namespace != "" || len(scope) > 0) {
		kept := make([]interface{}, 0, len(rows))
		for _, r := range rows {
			m, _ := r.(map[string]interface{})
			ns := fmt.Sprint(m["namespace"])
			if namespace != "" && ns != namespace {
				continue
			}
			if namespace == "" && len(scope) > 0 {
				in := false
				for _, s := range scope {
					if s == ns {
						in = true
						break
					}
				}
				if !in {
					continue
				}
			}
			kept = append(kept, r)
		}
		reply["rows"] = kept
	}
	capList(reply, "rows", rowsCap)
	reply["window"] = window
	reply["aggregate"] = aggregate
	reply["namespace"] = namespaceOrAll(namespace)
	if len(scope) > 0 && namespace == "" {
		reply["namespace"] = scope
	}
	return marshalJSON(reply)
}

// handleOptimization: requests vs usage with a recommendation per container
// of one namespace (features.optimization window, metrics-server or Prometheus).
func handleOptimization(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	if namespace == "" {
		return "", wrapBadRequest("namespace parameter is required")
	}
	q := url.Values{"namespace": {namespace}}
	if w := argInt(args, "window_hours", 0); w > 0 {
		q.Set("window", strconv.Itoa(w))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/optimization", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("optimization", "Usage data is unavailable here (no metrics-server or Prometheus). k8s_describe_resource still shows requests and limits.", status, body)
	if err != nil || out != "" {
		return out, err
	}
	// Rows with a recommendation first, largest requests first.
	if rows, ok := reply["rows"].([]interface{}); ok {
		sort.SliceStable(rows, func(i, j int) bool {
			a, _ := rows[i].(map[string]interface{})
			b, _ := rows[j].(map[string]interface{})
			ra, rb := a["cpu_recommend_m"] != nil || a["mem_recommend_bytes"] != nil, b["cpu_recommend_m"] != nil || b["mem_recommend_bytes"] != nil
			if ra != rb {
				return ra
			}
			fa, _ := a["cpu_request_m"].(float64)
			fb, _ := b["cpu_request_m"].(float64)
			return fa > fb
		})
		reply["rows"] = rows
	}
	capList(reply, "rows", rowsCap)
	if total, _ := reply["rows_total"].(float64); total == 0 {
		reply["hint"] = "No container with requests in that namespace, or no usage yet in the window."
	}
	return marshalJSON(reply)
}

// handleCanI asks the cluster whether the signed-in user may do verb on
// resource (SelfSubjectAccessReview as the impersonated user).
func handleCanI(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	verb := argString(args, "verb", "")
	resource := argString(args, "resource", "")
	if verb == "" || resource == "" {
		return "", wrapBadRequest("verb and resource are required (for example verb=delete resource=pods)")
	}
	q := url.Values{"verb": {verb}, "resource": {resource}}
	group := argString(args, "group", "")
	namespace := argString(args, "namespace", "")
	if group != "" {
		q.Set("group", group)
	}
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	status, body, err := k8sServiceGet(ctx, headers, "/can-i", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("can-i", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	reply["verb"] = verb
	reply["resource"] = resource
	reply["group"] = group
	reply["namespace"] = namespaceOrAll(namespace)
	if namespace == "" {
		reply["namespace"] = "cluster scope"
	}
	reply["note"] = "Answered by the cluster for the signed-in user (their RBAC), not for Kubeast's own identity."
	return marshalJSON(reply)
}

// handleResourceGraph: the objects of one namespace and the edges between
// them (owner, selector, volume, config references), capped, with counts by kind.
func handleResourceGraph(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	if namespace == "" {
		return "", wrapBadRequest("namespace parameter is required")
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/resource-graph", nil)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("resource-graph", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	if nodes, ok := reply["nodes"].([]interface{}); ok {
		counts := map[string]int{}
		for _, n := range nodes {
			m, _ := n.(map[string]interface{})
			kind := fmt.Sprint(m["kind"])
			if kind == "<nil>" || kind == "" {
				if data, ok := m["data"].(map[string]interface{}); ok {
					kind = fmt.Sprint(data["kind"])
				}
			}
			counts[kind]++
		}
		reply["counts_by_kind"] = counts
	}
	capList(reply, "nodes", graphNodesCap)
	capList(reply, "edges", graphEdgesCap)
	reply["namespace"] = namespace
	return marshalJSON(reply)
}

// handleNetworkPolicyCheck asks k8s-service whether NetworkPolicy allows src
// to reach dst; it reads the policies, pods and namespaces as the user.
func handleNetworkPolicyCheck(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	src := strings.TrimSpace(argString(args, "src", ""))
	dst := strings.TrimSpace(argString(args, "dst", ""))
	if src == "" || dst == "" {
		return "", wrapBadRequest("src and dst are required: <kind>/<namespace>/<name> (pod, deployment, statefulset, daemonset, replicaset, job, cronjob; dst may be service) or an IP address")
	}
	q := url.Values{"src": {src}, "dst": {dst}}
	if port := strings.TrimSpace(argString(args, "port", "")); port != "" {
		q.Set("port", port)
	}
	if protocol := strings.TrimSpace(argString(args, "protocol", "")); protocol != "" {
		q.Set("protocol", strings.ToUpper(protocol))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/networkpolicies/check", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("networkpolicy-check", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	capList(reply, "checks", netpolChecksCap)
	reply["note"] = "Kubernetes NetworkPolicy only, read as the signed-in user. result unknown: the answer depends on the network plugin " +
		"(an ipBlock that covers a pod IP, a hostNetwork pod) or on namespace labels the user cannot read — say which. " +
		"unevaluated lists other policy kinds (Cilium, Calico, AdminNetworkPolicy) in these namespaces that can change the answer. " +
		"notes dns_egress_denied: the source may not reach cluster DNS, so a Service name will not resolve even where the pods are allowed."
	return marshalJSON(reply)
}

// networkTarget reads the namespace and the pod or workload of the network tools into q.
func networkTarget(args map[string]interface{}, q url.Values) (string, error) {
	namespace := strings.TrimSpace(argString(args, "namespace", ""))
	if namespace == "" {
		return "", wrapBadRequest("namespace is required")
	}
	pod := strings.TrimSpace(argString(args, "pod", ""))
	kind, name := strings.TrimSpace(argString(args, "workload_kind", "")), strings.TrimSpace(argString(args, "workload_name", ""))
	switch {
	case pod != "" && (kind != "" || name != ""):
		return "", wrapBadRequest("give pod or workload_kind and workload_name, not both")
	case pod != "":
		q.Set("kind", "Pod")
		q.Set("name", pod)
	case kind != "" || name != "":
		if kind == "" || name == "" {
			return "", wrapBadRequest("workload_kind and workload_name go together")
		}
		q.Set("kind", kind)
		q.Set("name", name)
	}
	return namespace, nil
}

// handleNetworkFlows reads recent flows of a namespace, pod or workload from
// the cluster's Hubble Relay through k8s-service (as the user, audited there).
func handleNetworkFlows(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	namespace, err := networkTarget(args, q)
	if err != nil {
		return "", err
	}
	if v := strings.TrimSpace(argString(args, "verdict", "")); v != "" {
		q.Set("verdict", strings.ToUpper(v))
	}
	if v := strings.TrimSpace(argString(args, "since", "")); v != "" {
		q.Set("since", v)
	}
	if limit := argInt(args, "limit", 0); limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/networkflows", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("networkFlows", netflowsAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	capList(reply, "groups", netflowsGroupsCap)
	capList(reply, "flows", netflowsFlowsCap)
	reply["note"] = "Read from the cluster's Hubble Relay (or Calico's Whisker, provider calico) as the signed-in user. groups fold the flows of one connection (count, first, last; " +
		"observed = egress at the source, ingress at the destination). DROPPED with drop_reason POLICY_DENIED means a network policy blocked it: " +
		"call network_policy_check for the same source, destination and port to name the Kubernetes NetworkPolicy rule. " +
		"truncated: the Relay had more than the limit; redacted: peers outside the user's namespaces show namespace and address only."
	return marshalJSON(reply)
}

// netdropsUnavailable explains why a cluster has no drop counts to read.
var netdropsUnavailable = map[string]string{
	"no_prometheus":     "No Prometheus is set up for this cluster (features.prometheus).",
	"no_metrics":        "The cluster's Prometheus has no hubble_drop_total: the Hubble drop metric is not enabled or not scraped.",
	"no_context_labels": "hubble_drop_total has no pod or workload labels, so drops cannot be tied to a workload (see docs/cluster-requirements.md, Hubble metrics).",
}

// handleNetworkDrops reads the Hubble drops of a namespace, pod or workload from
// the cluster's Prometheus through k8s-service (as the user).
func handleNetworkDrops(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	namespace, err := networkTarget(args, q)
	if err != nil {
		return "", err
	}
	if v := strings.TrimSpace(argString(args, "since", "")); v != "" {
		q.Set("range", v)
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/networkdrops", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("networkDrops", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	if reply["available"] != true {
		reason, _ := reply["reason"].(string)
		reply["status"] = "unavailable"
		reply["note"] = netdropsUnavailable[reason] + " Use network_policy_check to see what NetworkPolicy allows."
		return marshalJSON(reply)
	}
	reply["note"] = "Counted by the Hubble agents (hubble_drop_total) over the range, read from the cluster's Prometheus as the signed-in user. " +
		"incoming: drops where the target is the destination, the peer is the source; outgoing: the reverse. " +
		"POLICY_DENIED means a network policy dropped it: call network_policy_check with that peer and the target (no port checks every declared port) " +
		"to name the Kubernetes NetworkPolicy rule, and network_flows for the connections themselves when the cluster has flow reads (a Hubble Relay or Calico's Whisker). " +
		"notes workload_level: the metric has no pod label, so a pod's numbers are its workload's. A peer without a namespace is outside the cluster or not named by the agent; " +
		"redacted: peers outside the user's namespaces show their namespace only."
	return marshalJSON(reply)
}

// handleNetworkTopFlows reads the top contributors of the cluster's Network Flow Monitor monitor with a
// namespace, pod or workload at either end, through k8s-service (Kubeast's AWS identity, audited there).
func handleNetworkTopFlows(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	namespace, err := networkTarget(args, q)
	if err != nil {
		return "", err
	}
	if v := strings.TrimSpace(argString(args, "metric", "")); v != "" {
		q.Set("metric", strings.ToUpper(v))
	}
	if v := strings.TrimSpace(argString(args, "destination", "")); v != "" {
		q.Set("view", v)
	}
	if v := strings.TrimSpace(argString(args, "since", "")); v != "" {
		q.Set("range", v)
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/networktopflows", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("networkFlowMonitor", nfmAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	capList(reply, "rows", nfmRowsCap)
	reply["note"] = "Top contributors of the cluster's Amazon CloudWatch Network Flow Monitor monitor over the range, largest value first, read with Kubeast's AWS identity " +
		"for a user who may list the namespace's pods. local is where the NFM agent measured, remote the other end; a connection between two pods can be listed " +
		"once from each end, so do not add the two. value is in unit (Bytes for data_transferred, Count for retransmissions and timeouts). category: INTRA_AZ and " +
		"INTER_AZ (within the cluster; INTER_AZ crosses zones and costs data transfer), AMAZON_S3, AMAZON_DYNAMODB, UNCLASSIFIED (internet or on-premises). " +
		"truncated: NFM gave as many rows as asked in a category; redacted: peers in namespaces whose pods the user cannot list show namespace and address only."
	return marshalJSON(reply)
}
