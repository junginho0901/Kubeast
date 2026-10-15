// k8s_diff previews what a manifest would change without applying it: the
// object as the API server would store it (apply --dry-run=server, so
// defaults, validation and admission all run) against the live object, as a
// unified diff of their JSON. The image is distroless and has no `diff`
// binary, so the diff itself is computed here.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
)

const (
	diffTextCap  = 64 << 10
	diffLinesCap = 4000
)

// diffNoise are fields the server owns; they differ between a dry run and
// the live object without meaning a change (kubectl diff drops them too).
var diffNoise = [][]string{
	{"metadata", "managedFields"}, {"metadata", "resourceVersion"}, {"metadata", "uid"}, {"metadata", "generation"},
	{"metadata", "creationTimestamp"}, {"metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration"},
	{"metadata", "annotations", "deployment.kubernetes.io/revision"}, {"status"},
}

func handleDiff(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return "", err
	}
	if strings.Contains("\n"+manifest, "\n---") {
		return "", wrapBadRequest("one object per call: split a multi-document manifest")
	}
	cmd := []string{"apply", "--dry-run=server", "-f", "-", "-o", "json"}
	if ns := argString(args, "namespace", ""); ns != "" {
		cmd = append(cmd, "-n", ns)
	}
	dry, err := runKubectlWithInput(ctx, headers, manifest, cmd...)
	if err != nil {
		if res, ok := failureResult(ctx, headers, err, "", "", argString(args, "namespace", "")); ok {
			return res, nil
		}
		return "", err
	}
	if i := strings.Index(dry, "{"); i > 0 {
		dry = dry[i:]
	}
	var want map[string]interface{}
	if err := json.Unmarshal([]byte(dry), &want); err != nil {
		return "", fmt.Errorf("dry run: unreadable output: %w", err)
	}
	kind, _ := want["kind"].(string)
	apiVersion, _ := want["apiVersion"].(string)
	meta, _ := want["metadata"].(map[string]interface{})
	name, _ := meta["name"].(string)
	namespace, _ := meta["namespace"].(string)
	if kind == "" || name == "" {
		return "", fmt.Errorf("dry run: the result has no kind or name")
	}

	// The live object, by the fully qualified type so a CRD kind cannot be confused.
	getArgs := []string{"get", qualifiedType(kind, apiVersion), name, "-o", "json"}
	if namespace != "" {
		getArgs = append(getArgs, "-n", namespace)
	}
	liveText, getErr := runKubectl(ctx, headers, getArgs...)
	status := "changed"
	var live map[string]interface{}
	if getErr != nil {
		if f, ok := classifyKubectlFailure(getErr); ok && f.Status == "not_found" {
			status = "created"
		} else {
			return "", getErr
		}
	} else {
		if i := strings.Index(liveText, "{"); i > 0 {
			liveText = liveText[i:]
		}
		if err := json.Unmarshal([]byte(liveText), &live); err != nil {
			return "", fmt.Errorf("live object: unreadable output: %w", err)
		}
	}
	for _, path := range diffNoise {
		dropPath(want, path)
		dropPath(live, path)
	}
	wantText := prettyJSON(want)
	liveTextClean := ""
	if live != nil {
		liveTextClean = prettyJSON(live)
	}
	label := kind + "/" + name
	if namespace != "" {
		label = namespace + "/" + label
	}
	diff, added, removed := unifiedDiff(liveTextClean, wantText, label)
	if status == "changed" && added == 0 && removed == 0 {
		status = "unchanged"
	}
	truncated := false
	if len(diff) > diffTextCap {
		diff = diff[:diffTextCap] + fmt.Sprintf(truncatedMarker, diffTextCap)
		truncated = true
	}
	out := map[string]interface{}{
		"status":        status,
		"kind":          kind,
		"apiVersion":    apiVersion,
		"name":          name,
		"namespace":     namespace,
		"lines_added":   added,
		"lines_removed": removed,
		"diff":          diff,
		"note":          "Server dry run against the live object; nothing was applied. Server defaults and admission mutations are included.",
	}
	if truncated {
		out["truncated"] = true
	}
	if status == "unchanged" {
		out["hint"] = "Applying this manifest would change nothing (ignoring server-owned fields and status)."
	}
	return marshalJSON(out)
}

// qualifiedType renders the type for kubectl get: the bare kind for the core
// group, Kind.group otherwise (kubectl reads the segments after the type as
// the group, so a CRD kind cannot be confused with a built-in one).
func qualifiedType(kind, apiVersion string) string {
	if i := strings.Index(apiVersion, "/"); i >= 0 {
		return kind + "." + apiVersion[:i]
	}
	return kind
}

func dropPath(obj map[string]interface{}, path []string) {
	if obj == nil || len(path) == 0 {
		return
	}
	if len(path) == 1 {
		delete(obj, path[0])
		return
	}
	next, ok := obj[path[0]].(map[string]interface{})
	if !ok {
		return
	}
	dropPath(next, path[1:])
	if len(next) == 0 {
		delete(obj, path[0])
	}
}

func prettyJSON(v interface{}) string {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return ""
	}
	return string(raw)
}

// unifiedDiff is a line diff (LCS) with a unified header and 3 lines of
// context; it returns the text and the added/removed counts. Very long
// inputs fall back to a whole-file replacement to keep the work bounded.
func unifiedDiff(a, b, label string) (string, int, int) {
	al := splitLines(a)
	bl := splitLines(b)
	var ops []diffOp
	if len(al) > diffLinesCap || len(bl) > diffLinesCap {
		for _, l := range al {
			ops = append(ops, diffOp{'-', l})
		}
		for _, l := range bl {
			ops = append(ops, diffOp{'+', l})
		}
	} else {
		ops = lcsOps(al, bl)
	}
	added, removed := 0, 0
	for _, op := range ops {
		switch op.kind {
		case '+':
			added++
		case '-':
			removed++
		}
	}
	if added == 0 && removed == 0 {
		return "", 0, 0
	}
	var sb strings.Builder
	sb.WriteString("--- live " + label + "\n+++ after apply " + label + "\n")
	// Hunks: runs of changes with up to 3 context lines around them.
	const ctxLines = 3
	i := 0
	for i < len(ops) {
		if ops[i].kind == ' ' {
			i++
			continue
		}
		start := i - ctxLines
		if start < 0 {
			start = 0
		}
		end := i
		for end < len(ops) {
			if ops[end].kind != ' ' {
				end++
				continue
			}
			// a context run: does another change follow within 2*ctx lines?
			j := end
			for j < len(ops) && ops[j].kind == ' ' && j-end < 2*ctxLines {
				j++
			}
			if j < len(ops) && ops[j].kind != ' ' {
				end = j
				continue
			}
			break
		}
		stop := end + ctxLines
		if stop > len(ops) {
			stop = len(ops)
		}
		sb.WriteString("@@\n")
		for _, op := range ops[start:stop] {
			sb.WriteByte(op.kind)
			sb.WriteString(op.text)
			sb.WriteByte('\n')
		}
		i = stop
	}
	return sb.String(), added, removed
}

type diffOp struct {
	kind byte
	text string
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimRight(s, "\n"), "\n")
}

// lcsOps is the classic dynamic-programming line diff.
func lcsOps(a, b []string) []diffOp {
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	ops := make([]diffOp, 0, n+m)
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, diffOp{' ', a[i]})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			ops = append(ops, diffOp{'-', a[i]})
			i++
		default:
			ops = append(ops, diffOp{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, diffOp{'-', a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, diffOp{'+', b[j]})
	}
	return ops
}

// exitCode reads the process exit status out of a kubectl error, if any.
func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
