// Reads of what a screen's route answers or computes: a pod's service account and bindings, a container's log files,
// the Storage window, the NetworkPolicies that select a pod, the pods outside a LimitRange and the Alerts inbox. Each
// asks the screen's own route with the caller's token, so its permission check, namespace scope and audit row are the
// screen's; this side keeps the answer's values and only caps a long list and leads with its summary.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
)

const (
	logFileDefaultLines = 50
	logFilesAlternative = "Log files are off on this installation (features.logFiles). Use k8s_get_pod_logs for what the pod writes to stdout, and logsearch where a log store exists."
	inboxDefaultLimit   = 50
	inboxSearchMaxChars = 200
)

// podRoutePath is the path of one pod's routes; both names are required.
func podRoutePath(tool string, args map[string]interface{}) (string, error) {
	namespace, pod := argString(args, "namespace", ""), argString(args, "pod_name", "")
	if namespace == "" || pod == "" {
		return "", wrapBadRequest(tool + " needs namespace and pod_name")
	}
	return "/namespaces/" + url.PathEscape(namespace) + "/pods/" + url.PathEscape(pod), nil
}

// handlePodRBAC: the pod's service account and the bindings that name it.
func handlePodRBAC(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	path, err := podRoutePath("pod_rbac", args)
	if err != nil {
		return "", err
	}
	status, body, err := k8sServiceGet(ctx, headers, path+"/rbac", nil)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("pod-rbac", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	capList(reply, "bindings", rowsCap)
	reply["note"] = "bindings names the roles this pod's service account is bound to, not what they allow. For that call k8s_describe_resource on each one (resource_type role in this namespace or clusterrole, resource_name role_name). secrets are names only. Groups the account belongs to are not looked at, and admission can still refuse what RBAC allows."
	return marshalJSON(reply)
}

// logFileRead keeps the lines last, so a cut at the model's limit keeps what says what they are.
type logFileRead struct {
	Path      string `json:"path"`
	Container string `json:"container"`
	Lines     int    `json:"lines"`
	Truncated bool   `json:"truncated"`
	Content   string `json:"content"`
}

// endOfText is the last max bytes of text, from the start of a line when there is one.
func endOfText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	end := text[len(text)-max:]
	if i := strings.IndexByte(end, '\n'); i >= 0 && i+1 < len(end) {
		return end[i+1:]
	}
	return end
}

// handleLogFiles is the Log files tab: without path the files its patterns cover, with path the last lines of one
// file. k8s-service runs its fixed ls or tail through the user's pods/exec, each ending at once, and records the read
// as k8s.pod.logfile.read; following a file stays on the screen.
func handleLogFiles(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	path, err := podRoutePath("logfiles", args)
	if err != nil {
		return "", err
	}
	q := url.Values{}
	if container := argString(args, "container", ""); container != "" {
		q.Set("container", container)
	}
	file := argString(args, "path", "")
	if file == "" {
		status, body, err := k8sServiceGet(ctx, headers, path+"/logfiles", q)
		if err != nil {
			return "", err
		}
		if status != http.StatusOK {
			return logFileFailure(status, body)
		}
		var reply map[string]interface{}
		if err := json.Unmarshal(body, &reply); err != nil {
			return "", fmt.Errorf("log files: unreadable reply: %w", err)
		}
		return marshalJSON(reply)
	}
	lines := argInt(args, "lines", logFileDefaultLines)
	if lines <= 0 {
		lines = logFileDefaultLines
	}
	if lines > maxLogTailLines {
		lines = maxLogTailLines
	}
	q.Set("path", file)
	q.Set("lines", strconv.Itoa(lines))
	status, body, err := k8sServiceGet(ctx, headers, path+"/logfiles/content", q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return logFileFailure(status, body)
	}
	var read logFileRead
	if err := json.Unmarshal(body, &read); err != nil {
		if len(body) >= featureBodyCap {
			return marshalJSON(map[string]interface{}{"status": "failed", "feature": "logFiles", "code": "too_large", "path": file,
				"reason": fmt.Sprintf("those %d lines are larger than a tool answer holds", lines), "hint": "Ask for fewer lines."})
		}
		return "", fmt.Errorf("log files: unreadable reply: %w", err)
	}
	if len(read.Content) > outputMaxBytes {
		read.Content, read.Truncated = endOfText(read.Content, outputMaxBytes), true
	}
	return marshalJSON(read)
}

// logFileFailure turns a refusal of the log files routes into a result, with the tab's reason as code.
func logFileFailure(status int, body []byte) (string, error) {
	var reply struct {
		Detail string `json:"detail"`
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(body, &reply)
	detail := reply.Detail
	if detail == "" {
		detail = detailOf(body)
	}
	result := func(state, hint string) (string, error) {
		answer := map[string]interface{}{"status": state, "feature": "logFiles", "reason": detail, "hint": hint}
		if reply.Reason != "" {
			answer["code"] = reply.Reason
		}
		return marshalJSON(answer)
	}
	switch {
	case reply.Reason == "disabled":
		return unavailableResult("logFiles", detail, logFilesAlternative)
	case reply.Reason == "path":
		return result("forbidden", "Only files the configured patterns cover can be read. Call without path to list them.")
	case reply.Reason == "lines" || status == http.StatusBadRequest:
		return "", wrapBadRequest(detail)
	case status == http.StatusServiceUnavailable:
		return result("audit_unavailable", "Nothing was read: the audit log cannot take the record right now. Tell the user.")
	case status == http.StatusForbidden:
		return result("forbidden", "Your grant or the cluster does not allow it. Tell the user what was refused instead of trying another way.")
	case status == http.StatusNotFound:
		return result("not_found", "Call without path to list the files of this container, and k8s_find_resource to find the pod.")
	case status == http.StatusUnprocessableEntity:
		return result("failed", "The command ran in the container and could not read the file. Tell the user why.")
	}
	return "", fmt.Errorf("k8s-service log files: status %d: %s", status, detail)
}

// The Storage window lists what needs a person first.
var (
	pvcStatusRank = map[string]int{"Pending": 0, "Lost": 1, "Bound": 2}
	pvStatusRank  = map[string]int{"Failed": 0, "Released": 1, "Available": 2, "Bound": 3}
)

func rankOf(ranks map[string]int, status string) int {
	if rank, ok := ranks[status]; ok {
		return rank
	}
	return len(ranks)
}

func statusCountsOf(rows []interface{}) map[string]int {
	counts := map[string]int{}
	for _, row := range rows {
		m, _ := row.(map[string]interface{})
		status, ok := m["status"].(string)
		if !ok {
			status = "Unknown"
		}
		counts[status]++
	}
	return counts
}

func sortByStatus(rows []interface{}, ranks map[string]int) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, _ := rows[i].(map[string]interface{})
		b, _ := rows[j].(map[string]interface{})
		ra, rb := rankOf(ranks, fmt.Sprint(a["status"])), rankOf(ranks, fmt.Sprint(b["status"]))
		if ra != rb {
			return ra < rb
		}
		return fmt.Sprint(a["namespace"], "/", a["name"]) < fmt.Sprint(b["namespace"], "/", b["name"])
	})
}

func rowsOf(feature string, body []byte) ([]interface{}, error) {
	rows := []interface{}{}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("%s: unreadable reply: %w", feature, err)
	}
	return rows, nil
}

// handleStorageSummary is the Storage window: every claim with its usage and every volume, counted by status, and the
// topology. A list the cluster refuses this caller is said; the others stand, as the window's tabs do. The window
// computes no total capacity, so neither does this.
func handleStorageSummary(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	status, body, err := k8sServiceGet(ctx, headers, "/pvcs", url.Values{"usage": {"true"}})
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("storage", "", status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	claims, err := rowsOf("pvcs", body)
	if err != nil {
		return "", err
	}
	grant := scopedNamespaces(ctx)
	kept := make([]interface{}, 0, len(claims))
	for _, claim := range claims {
		m, _ := claim.(map[string]interface{})
		ns := fmt.Sprint(m["namespace"])
		if (namespace != "" && ns != namespace) || (len(grant) > 0 && !slices.Contains(grant, ns)) {
			continue
		}
		kept = append(kept, claim)
	}
	sortByStatus(kept, pvcStatusRank)
	reply := map[string]interface{}{
		"namespace":         namespaceOrAll(namespace),
		"pvc_status_counts": statusCountsOf(kept),
		"pvcs":              kept,
		"note":              "usage is the kubelet's view through Prometheus and is absent where it is not scraped or the volume's driver reports none. topology is every claim and volume this user may read, whatever namespace was asked.",
	}
	if namespace == "" && len(grant) > 0 {
		reply["namespace"] = grant
	}
	capList(reply, "pvcs", rowsCap)

	status, body, err = k8sServiceGet(ctx, headers, "/pvs", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		reply["pvs_error"] = detailOf(body)
	} else {
		volumes, err := rowsOf("pvs", body)
		if err != nil {
			return "", err
		}
		if namespace != "" {
			inNamespace := make([]interface{}, 0, len(volumes))
			for _, volume := range volumes {
				m, _ := volume.(map[string]interface{})
				if claim, _ := m["claim_ref"].(map[string]interface{}); claim != nil && claim["namespace"] == namespace {
					inNamespace = append(inNamespace, volume)
				}
			}
			volumes = inNamespace
		}
		sortByStatus(volumes, pvStatusRank)
		reply["pv_status_counts"] = statusCountsOf(volumes)
		reply["pvs"] = volumes
		capList(reply, "pvs", rowsCap)
	}

	status, body, err = k8sServiceGet(ctx, headers, "/topology/storage", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		reply["topology_error"] = detailOf(body)
	} else {
		var graph struct {
			Nodes    []interface{}          `json:"nodes"`
			Edges    []interface{}          `json:"edges"`
			Metadata map[string]interface{} `json:"metadata"`
		}
		if err := json.Unmarshal(body, &graph); err != nil {
			return "", fmt.Errorf("storage topology: unreadable reply: %w", err)
		}
		topology := map[string]interface{}{"pv_count": graph.Metadata["pv_count"], "pvc_count": graph.Metadata["pvc_count"], "nodes_total": len(graph.Nodes), "edges": graph.Edges}
		capList(topology, "edges", rowsCap)
		reply["topology"] = topology
	}
	return marshalOrdered(reply, []string{"namespace", "pvcs_total", "pvc_status_counts", "pvs_total", "pv_status_counts", "pvs_error", "topology_error", "truncated"},
		[]string{"pvcs", "pvs", "topology"})
}

// handleNetworkPolicyEffective is a drawer's "Network Policies": the policies that select the pod or the workload's
// pods, per direction, with what their rules allow.
func handleNetworkPolicyEffective(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	namespace, err := networkTarget(args, q)
	if err != nil {
		return "", err
	}
	if q.Get("name") == "" {
		return "", wrapBadRequest("give pod, or workload_kind and workload_name")
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/networkpolicies/effective", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("networkpolicy-effective", "", status, body)
	if err != nil || out != "" {
		return out, err
	}
	reply["note"] = "isolated false: nothing limits that direction. isolated true: only what the listed rules allow; a policy with no rules denies all. An empty selector selects everything. unevaluated lists other policy kinds in this namespace that can change the answer (count -1: they could not be listed). network_policy_check decides one connection."
	return marshalJSON(reply)
}

// handleLimitRangeViolations is a LimitRange window's "Violating Pods": containers outside its bounds, which the API
// server let in before the LimitRange existed or while it was off.
func handleLimitRangeViolations(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace, name := argString(args, "namespace", ""), argString(args, "name", "")
	if namespace == "" || name == "" {
		return "", wrapBadRequest("limit_range_violations needs namespace and name")
	}
	status, body, err := k8sServiceGet(ctx, headers, "/namespaces/"+url.PathEscape(namespace)+"/limitranges/"+url.PathEscape(name)+"/violations", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("limitrange-violations", "", status, body)
		if ok {
			return out, nil
		}
		return "", ferr
	}
	rows, err := rowsOf("limitrange violations", body)
	if err != nil {
		return "", err
	}
	reply := map[string]interface{}{"namespace": namespace, "name": name, "violations": rows,
		"note": "One row per field of a container, so a pod can have several; violations_total counts the rows, as the window's Violating Pods does."}
	capList(reply, "violations", rowsCap)
	return marshalOrdered(reply, []string{"namespace", "name", "violations_total", "truncated", "note"}, []string{"violations"})
}

// handleAlertsInbox reads the Alerts inbox: a page of the list, or with alert_id one alert as its window opens, with
// the note the list leaves out. Reading only: a mark or a press stays on the screen.
func handleAlertsInbox(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if id := argString(args, "alert_id", ""); id != "" {
		window, out, err := inboxWindowOf(ctx, headers, id)
		if err != nil || out != "" {
			return out, err
		}
		window["alert_link"] = consoleURL + "/alerts?" + url.Values{"alert": {id}, "cluster": {clusterIDFromCtx(ctx)}}.Encode()
		return marshalOrdered(window, []string{"id", "alertname", "severity", "namespace", "status", "acknowledged", "acked_by", "acked_at", "assignee", "done", "done_by", "done_at", "note", "note_by", "note_at", "alert_link", "summary"},
			[]string{"labels", "annotations"})
	}
	search := argString(args, "search", "")
	if len([]rune(search)) > inboxSearchMaxChars {
		return "", wrapBadRequest(fmt.Sprintf("search: at most %d characters", inboxSearchMaxChars))
	}
	limit := argInt(args, "limit", inboxDefaultLimit)
	if limit <= 0 {
		limit = inboxDefaultLimit
	}
	if limit > inboxPageSize {
		limit = inboxPageSize
	}
	q := url.Values{"cluster": {clusterIDFromCtx(ctx)}, "limit": {strconv.Itoa(limit)}}
	if offset := argInt(args, "offset", 0); offset > 0 {
		q.Set("offset", strconv.Itoa(offset))
	}
	for name, arg := range map[string]string{"status": "status", "severity": "alert_severity", "q": "search"} {
		if value := argString(args, arg, ""); value != "" {
			q.Set(name, value)
		}
	}
	for name, arg := range map[string]string{"mine": "mine", "open": "open_only"} {
		if argBool(args, arg) {
			q.Set(name, "true")
		}
	}
	status, body, err := aiServiceDo(ctx, headers, http.MethodGet, "/api/v1/alerts/inbox", q)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return inboxFailure(status, body)
	}
	var reply map[string]interface{}
	if err := json.Unmarshal(body, &reply); err != nil {
		return "", fmt.Errorf("alert inbox: unreadable reply: %w", err)
	}
	if reply["total"] == float64(0) {
		reply["hint"] = inboxNotFoundHint
	}
	return marshalOrdered(reply, []string{"total", "counts", "limit", "offset", "stale_hours", "severities", "hint"}, []string{"items"})
}
