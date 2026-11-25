// The neighbours of one node as a tool: k8s-service ranks the containers on the node by the cores they used, compares
// the window with the one before it and says whom to suspect (internal/nodecpu), as the caller. The rows go to the model
// as the lines of a table, since the answer is indented for it, and the answer stays under nodeNeighborsChars as it is
// shown: the last rows without a role go first, then long names and sentences are cut, and the answer says how many rows
// are left out.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// nodeNeighborsChars is under the model's default result limit (6000), with room for the links a result can get.
const nodeNeighborsChars = 5200

const nodeNeighborsAlternative = "get_node_metrics without node for each node's current usage, get_pod_metrics for the pods, prometheus_query for history."

var (
	nodeNeighborsFirstKeys = []string{"node", "reading", "window", "compared_with", "compared", "step_seconds", "source", "not_run", "cannot_say",
		"containers_total", "containers_note", "not_listed", "not_shown", "store_queries"}
	nodeNeighborsLastKeys = []string{"columns", "containers"}
)

// The table's columns, with the figures of the windows or with the current values alone.
const (
	nodeWindowColumns  = "rank | container (owner) | role | cores | before | grew | peak | request | limit | started | throttled (before) | waited for a CPU (before)"
	nodeCurrentColumns = "rank | container (owner) | cores now | request | limit | started"
)

// handleNodeMetricsOrNeighbors is get_node_metrics: every node's current usage (kubectl top nodes), or with node that
// node's neighbours.
func handleNodeMetricsOrNeighbors(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	if node := strings.TrimSpace(argString(args, "node", "")); node != "" {
		return handleNodeNeighbors(ctx, node, args, headers)
	}
	return handleGetNodeMetrics(ctx, args, headers)
}

// handleNodeNeighbors answers what used node's CPU between since_time–until_time (k8s-service's default half hour when
// none is given) and the window before it.
func handleNodeNeighbors(ctx context.Context, node string, args map[string]interface{}, headers http.Header) (string, error) {
	q := url.Values{}
	// k8s-service ends a window it is not given at the minute, so a relative start counts back from there too
	end := time.Now().Truncate(time.Minute)
	if until := argString(args, "until_time", ""); until != "" {
		t, err := time.Parse(time.RFC3339, until)
		if err != nil {
			return "", wrapBadRequest("until_time must be an RFC3339 time")
		}
		q.Set("end", t.UTC().Format(time.RFC3339))
		if t.Before(end) {
			end = t
		}
	}
	if since := argString(args, "since_time", ""); since != "" {
		t, err := parseFromTime(since, end)
		if err != nil {
			return "", wrapBadRequest("since_time: " + err.Error())
		}
		q.Set("start", t.UTC().Format(time.RFC3339))
	}
	status, body, err := k8sServiceGet(ctx, headers, "/nodes/"+url.PathEscape(node)+"/neighbors", q)
	if err != nil {
		return "", err
	}
	reply, out, err := featureReply("get_node_metrics", nodeNeighborsAlternative, status, body)
	if err != nil || out != "" {
		return out, err
	}
	return fitNodeNeighbors(reply)
}

// nodeNeighborsCuts are what an answer that is still too long without its rows without a role is cut to, one after the
// other: a name in a row keeps its head and its tail, a sentence its head. 0 cuts nothing.
var nodeNeighborsCuts = []struct{ name, text int }{{0, 0}, {160, 500}, {100, 250}, {60, 120}, {40, 60}}

// fitNodeNeighbors writes the rows as a table and keeps the answer under nodeNeighborsChars whatever the names are: the
// last rows without a role go first, then long names and sentences are cut, and at the last cut rows with a role go too.
func fitNodeNeighbors(reply map[string]interface{}) (string, error) {
	var rows []map[string]interface{}
	list, _ := reply["containers"].([]interface{})
	for _, r := range list {
		if row, ok := r.(map[string]interface{}); ok {
			rows = append(rows, row)
		}
	}
	current := reply["source"] == "metrics_api"
	if len(rows) > 0 {
		reply["columns"] = nodeWindowColumns
		if current {
			reply["columns"] = nodeCurrentColumns
		}
	}
	for i, cut := range nodeNeighborsCuts {
		last := i == len(nodeNeighborsCuts)-1
		out, fits, err := fitNodeRows(cutNodeTexts(reply, cut.text), rows, current, cut.name, last)
		if err != nil || fits || last {
			return out, err
		}
	}
	return "", nil
}

// fitNodeRows writes reply with as many of rows as fit, the last ones without a role left out first, and with every the
// last ones with a role after them. The first row stays.
func fitNodeRows(reply map[string]interface{}, rows []map[string]interface{}, current bool, name int, every bool) (out string, fits bool, err error) {
	kept := append([]map[string]interface{}{}, rows...)
	for {
		lines := make([]string, 0, len(kept))
		for _, row := range kept {
			lines = append(lines, nodeRowLine(row, current, name))
		}
		reply["containers"] = lines
		if left := len(rows) - len(kept); left > 0 {
			reply["containers_note"] = fmt.Sprintf("%d more rows, the smallest and those without a role first, were left out to keep the answer short.", left)
		}
		if out, err = marshalOrdered(reply, nodeNeighborsFirstKeys, nodeNeighborsLastKeys); err != nil || shownLength(out) <= nodeNeighborsChars {
			return out, true, err
		}
		drop := -1
		for i := len(kept) - 1; i > 0; i-- {
			if role, _ := kept[i]["role"].(string); role == "" {
				drop = i
				break
			}
		}
		if drop < 0 && every && len(kept) > 1 {
			drop = len(kept) - 1
		}
		if drop < 0 {
			return out, false, nil
		}
		kept = append(kept[:drop], kept[drop+1:]...)
	}
}

// cutNodeTexts is reply with its sentences cut to most characters (0: as they are).
func cutNodeTexts(reply map[string]interface{}, most int) map[string]interface{} {
	out := make(map[string]interface{}, len(reply))
	for k, v := range reply {
		out[k] = v
	}
	if most == 0 {
		return out
	}
	for _, key := range []string{"reading", "cannot_say", "not_run"} {
		list, _ := reply[key].([]interface{})
		cut := make([]interface{}, 0, len(list))
		for _, item := range list {
			switch v := item.(type) {
			case string:
				cut = append(cut, headOf(v, most))
			case map[string]interface{}:
				what, _ := v["what"].(string)
				reason, _ := v["reason"].(string)
				cut = append(cut, map[string]interface{}{"what": headOf(what, most), "reason": headOf(reason, most)})
			}
		}
		out[key] = cut
	}
	return out
}

func headOf(s string, most int) string {
	r := []rune(s)
	if len(r) <= most {
		return s
	}
	return string(r[:most-1]) + "…"
}

// middleCut keeps the head and the tail of a name longer than most (0: as it is): what tells pods of one workload apart
// is at the end.
func middleCut(s string, most int) string {
	r := []rune(s)
	if most == 0 || len(r) <= most {
		return s
	}
	head := most / 2
	return string(r[:head]) + "…" + string(r[len(r)-(most-head-1):])
}

// shownLength is the length of a JSON answer as ai-service shows it to the model, indented by two.
func shownLength(out string) int {
	var v interface{}
	if json.Unmarshal([]byte(out), &v) != nil {
		return len(out)
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return len(out)
	}
	return len(b)
}

// nodeRowLine is a row as a line of the table, its names cut to most characters (0: as they are).
func nodeRowLine(row map[string]interface{}, current bool, most int) string {
	name := middleCut(fmt.Sprint(row["target"]), most)
	if owner, _ := row["owner"].(string); owner != "" {
		name += " (" + middleCut(owner, most) + ")"
	}
	if gone, _ := row["gone"].(bool); gone {
		name += " [gone]"
	}
	text := func(key string) string {
		if s, _ := row[key].(string); s != "" {
			return s
		}
		return "?"
	}
	if current {
		return strings.Join([]string{number(row["rank"]), name, number(row["cores"]), text("request"), text("limit"), text("started_at")}, " | ")
	}
	role, _ := row["role"].(string)
	if role == "" {
		role = "-"
	}
	before := number(row["before_cores"])
	if fresh, _ := row["new"].(bool); fresh {
		before = "none"
	}
	return strings.Join([]string{number(row["rank"]), name, role, number(row["cores"]), before, signed(row["grew_cores"]), number(row["peak_cores"]),
		text("request"), text("limit"), text("started_at"), withBefore(row, "throttled"), withBefore(row, "waiting")}, " | ")
}

// number is a JSON number as written, "-" for one that is not there.
func number(v interface{}) string {
	if f, ok := v.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return "-"
}

func signed(v interface{}) string {
	if f, ok := v.(float64); ok && f > 0 {
		return "+" + number(v)
	}
	return number(v)
}

func withBefore(row map[string]interface{}, key string) string {
	now := number(row[key])
	if before := number(row[key+"_before"]); before != "-" {
		return now + " (" + before + ")"
	}
	return now
}
