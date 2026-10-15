// Query tools that shrink what a large cluster hands the model: a jq filter
// over `kubectl get -o json`, a custom-columns table, and a count grouped by a
// field — the HolmesGPT kubernetes toolset's jq/tabular/count shape. The list
// still comes from kubectl as the user; only the filtering runs here.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/itchyny/gojq"
)

const (
	jqResultsCap   = 200
	jqOutputCap    = 256 << 10
	jqTimeout      = 5 * time.Second
	tabularRowsCap = 200
	countGroupsCap = 100
)

// listArgs builds the kubectl get arguments shared by the three tools:
// kind, the namespace scope (a namespace-scoped grant never widens to the
// cluster), and the selectors.
func listArgs(ctx context.Context, args map[string]interface{}) ([]string, string, error) {
	kind := argString(args, "resource_type", "")
	if kind == "" {
		return nil, "", wrapBadRequest("resource_type parameter is required")
	}
	namespace := argString(args, "namespace", "")
	cmd := []string{"get", kind}
	scope := "all namespaces"
	switch {
	case namespace != "":
		cmd = append(cmd, "-n", namespace)
		scope = namespace
	case len(scopedNamespaces(ctx)) > 0:
		// The gate already required a namespace for a scoped grant; never widen.
		return nil, "", wrapBadRequest("namespace parameter is required")
	default:
		cmd = append(cmd, "--all-namespaces")
	}
	if v := argString(args, "label_selector", ""); v != "" {
		cmd = append(cmd, "-l", v)
	}
	if v := argString(args, "field_selector", ""); v != "" {
		cmd = append(cmd, "--field-selector="+v)
	}
	return cmd, scope, nil
}

// getJSONList runs kubectl get -o json and decodes the list.
func getJSONList(ctx context.Context, headers http.Header, cmd []string, kind, namespace string) (map[string]interface{}, string, error) {
	out, err := runKubectl(ctx, headers, append(cmd, "-o", "json")...)
	if err != nil {
		if res, ok := failureResult(ctx, headers, err, kind, "", namespace); ok {
			return nil, res, nil
		}
		return nil, "", err
	}
	// Warnings kubectl prints before the JSON (deprecations) are skipped.
	if i := strings.Index(out, "{"); i > 0 {
		out = out[i:]
	}
	var list map[string]interface{}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, "", fmt.Errorf("kubectl get -o json: unreadable output: %w", err)
	}
	return list, "", nil
}

func itemsOf(list map[string]interface{}) []interface{} {
	items, _ := list["items"].([]interface{})
	return items
}

// handleJQQuery: kubectl get -o json piped through a jq expression. The
// expression sees the whole list object ({"items": [...]}), so `.items[] |
// select(...) | .metadata.name` is the usual shape. Environment access is
// off (gojq's library default already yields an empty env; the loader below
// makes that explicit); results are capped.
func handleJQQuery(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	expr := strings.TrimSpace(argString(args, "jq", ""))
	if expr == "" {
		return "", wrapBadRequest("jq parameter is required (for example .items[] | select(.status.phase != \"Running\") | .metadata.name)")
	}
	query, err := gojq.Parse(expr)
	if err != nil {
		return "", wrapBadRequest("jq: " + err.Error())
	}
	code, err := gojq.Compile(query, gojq.WithEnvironLoader(func() []string { return nil }))
	if err != nil {
		return "", wrapBadRequest("jq: " + err.Error())
	}
	limit := argInt(args, "limit", 50)
	if limit <= 0 {
		limit = 50
	}
	if limit > jqResultsCap {
		limit = jqResultsCap
	}
	cmd, scope, err := listArgs(ctx, args)
	if err != nil {
		return "", err
	}
	list, res, err := getJSONList(ctx, headers, cmd, argString(args, "resource_type", ""), argString(args, "namespace", ""))
	if err != nil || res != "" {
		return res, err
	}
	runCtx, cancel := context.WithTimeout(ctx, jqTimeout)
	defer cancel()
	results := make([]interface{}, 0, limit)
	matches := 0
	size := 0
	truncated := false
	iter := code.RunWithContext(runCtx, list)
	for {
		v, ok := iter.Next()
		if !ok {
			break
		}
		if jqErr, isErr := v.(error); isErr {
			if runCtx.Err() != nil {
				return "", wrapBadRequest("jq: the expression took longer than 5s")
			}
			return "", wrapBadRequest("jq: " + jqErr.Error())
		}
		matches++
		if len(results) >= limit {
			truncated = true
			continue
		}
		raw, _ := json.Marshal(v)
		if size+len(raw) > jqOutputCap {
			truncated = true
			continue
		}
		size += len(raw)
		results = append(results, v)
	}
	out := map[string]interface{}{
		"jq":                    expr,
		"resource_type":         argString(args, "resource_type", ""),
		"scope":                 scope,
		"total_items_processed": len(itemsOf(list)),
		"matches_found":         matches,
		"results":               results,
	}
	if truncated {
		out["truncated"] = true
	}
	if matches == 0 {
		out["hint"] = "The expression matched nothing. Check the field path against k8s_get_resource_yaml of one object, or loosen the select()."
	}
	return marshalJSON(out)
}

// handleTabularQuery: kubectl get -o custom-columns with the model's columns,
// optional --sort-by, capped at tabularRowsCap rows.
func handleTabularQuery(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	columns := strings.TrimSpace(argString(args, "columns", ""))
	if columns == "" {
		columns = "NAMESPACE:.metadata.namespace,NAME:.metadata.name"
	}
	cmd, scope, err := listArgs(ctx, args)
	if err != nil {
		return "", err
	}
	cmd = append(cmd, "-o", "custom-columns="+columns)
	if v := argString(args, "sort_by", ""); v != "" {
		cmd = append(cmd, "--sort-by="+v)
	}
	out, err := runKubectl(ctx, headers, cmd...)
	if err != nil {
		return explainFailure(ctx, headers, err, argString(args, "resource_type", ""), "", argString(args, "namespace", ""))
	}
	limit := argInt(args, "limit", 100)
	if limit <= 0 {
		limit = 100
	}
	if limit > tabularRowsCap {
		limit = tabularRowsCap
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	header := ""
	rows := lines
	if len(lines) > 0 {
		header, rows = lines[0], lines[1:]
	}
	total := len(rows)
	if len(rows) > limit {
		rows = rows[:limit]
	}
	text := header
	if len(rows) > 0 {
		text += "\n" + strings.Join(rows, "\n")
	}
	summary := fmt.Sprintf("# %s in %s: %d rows", argString(args, "resource_type", ""), scope, total)
	if total > limit {
		summary += fmt.Sprintf(", showing the first %d", limit)
	}
	if total == 0 {
		summary += " (none)"
	}
	return summary + "\n" + text, nil
}

// handleCount: how many objects, optionally grouped by one field path
// (.status.phase, .metadata.namespace, .spec.nodeName).
func handleCount(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	cmd, scope, err := listArgs(ctx, args)
	if err != nil {
		return "", err
	}
	list, res, err := getJSONList(ctx, headers, cmd, argString(args, "resource_type", ""), argString(args, "namespace", ""))
	if err != nil || res != "" {
		return res, err
	}
	items := itemsOf(list)
	out := map[string]interface{}{
		"resource_type": argString(args, "resource_type", ""),
		"scope":         scope,
		"count":         len(items),
	}
	if path := argString(args, "group_by", ""); path != "" {
		counts := map[string]int{}
		for _, it := range items {
			counts[fieldString(it, path)]++
		}
		type group struct {
			Key   string `json:"key"`
			Count int    `json:"count"`
		}
		groups := make([]group, 0, len(counts))
		for k, c := range counts {
			groups = append(groups, group{k, c})
		}
		sort.Slice(groups, func(i, j int) bool {
			if groups[i].Count != groups[j].Count {
				return groups[i].Count > groups[j].Count
			}
			return groups[i].Key < groups[j].Key
		})
		if len(groups) > countGroupsCap {
			groups = groups[:countGroupsCap]
			out["truncated"] = true
		}
		out["group_by"] = path
		out["groups"] = groups
	}
	return marshalJSON(out)
}

// fieldString walks a dotted path (.status.phase) through decoded JSON; a
// missing value reads as "<none>".
func fieldString(v interface{}, path string) string {
	cur := v
	for _, seg := range strings.Split(strings.TrimPrefix(path, "."), ".") {
		if seg == "" {
			continue
		}
		m, ok := cur.(map[string]interface{})
		if !ok {
			return "<none>"
		}
		cur, ok = m[seg]
		if !ok || cur == nil {
			return "<none>"
		}
	}
	switch t := cur.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		raw, _ := json.Marshal(t)
		return string(raw)
	}
}
