// Pods through k8s-service's pod rows (GET /api/v1/pods/page) instead of
// kubectl: a large cluster's pod list does not fit the tool output cap
// (TOOL_OUTPUT_MAX_BYTES), and k8s-service already keeps a row per pod and
// checks that the caller may list them.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	// podsInlineRows: a pods list longer than this is answered with its counts and a page of it.
	podsInlineRows = 25
	podsGroupTop   = 10
)

type podGroup struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type podPageReply struct {
	Items []struct {
		Name         string `json:"name"`
		Namespace    string `json:"namespace"`
		Status       string `json:"status"`
		Ready        string `json:"ready"`
		RestartCount int    `json:"restart_count"`
		NodeName     string `json:"node_name"`
	} `json:"items"`
	Total int `json:"total"`
	Stats struct {
		Total      int `json:"total"`
		TopReasons []struct {
			Reason string `json:"reason"`
			Count  int    `json:"count"`
		} `json:"top_reasons"`
		Health struct {
			OK    int `json:"ok"`
			Warn  int `json:"warn"`
			Error int `json:"error"`
		} `json:"health"`
	} `json:"stats"`
	ByNamespace []podGroup `json:"by_namespace"`
	ByNode      []podGroup `json:"by_node"`
	ByPhase     []podGroup `json:"by_phase"`
}

func isPodsKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "pods", "pod", "po":
		return true
	}
	return false
}

// podPage asks k8s-service for one page of pod rows; out is the tool's answer when k8s-service refused.
func podPage(ctx context.Context, headers http.Header, q url.Values) (*podPageReply, string, error) {
	status, body, err := k8sServiceGet(ctx, headers, "/pods/page", q)
	if err != nil {
		return nil, "", err
	}
	if status != http.StatusOK {
		out, ok, ferr := featureFailure("pods", "", status, body)
		if ok {
			return nil, out, nil
		}
		return nil, "", ferr
	}
	var p podPageReply
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, "", fmt.Errorf("k8s-service /pods/page: %w", err)
	}
	return &p, "", nil
}

func (p *podPageReply) lines() []string {
	out := make([]string, 0, len(p.Items))
	for _, it := range p.Items {
		node := it.NodeName
		if node == "" {
			node = "<none>"
		}
		out = append(out, fmt.Sprintf("%s/%s %s ready=%s restarts=%d node=%s", it.Namespace, it.Name, it.Status, it.Ready, it.RestartCount, node))
	}
	return out
}

// podsList is k8s_get_resources for pods without a name, when they are more than podsInlineRows: the counts over
// all of them, then a page of the pods in order of need (errors, warnings, the rest). Fields are in reading order:
// what the answer covers and how to go on come before the long lists. ok is false when the list is short (kubectl
// answers it as before) or k8s-service could not be asked.
func podsList(ctx context.Context, headers http.Header, namespace string, offset int) (string, bool, error) {
	q := url.Values{"sort": {"health"}, "groups": {"1"}, "group_top": {strconv.Itoa(podsGroupTop)},
		"limit": {strconv.Itoa(podsInlineRows)}, "offset": {strconv.Itoa(max(offset, 0))}}
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	p, out, err := podPage(ctx, headers, q)
	if err != nil {
		return "", false, nil
	}
	if out != "" {
		return out, true, nil
	}
	if p.Stats.Total <= podsInlineRows && offset <= 0 {
		return "", false, nil
	}
	scope := "all namespaces"
	if namespace != "" {
		scope = namespace
	}
	attention := p.Stats.Health.Warn + p.Stats.Health.Error
	type reasonCount struct {
		Status string `json:"status"`
		Count  int    `json:"count"`
	}
	reasons := make([]reasonCount, 0, len(p.Stats.TopReasons))
	for _, r := range p.Stats.TopReasons {
		reasons = append(reasons, reasonCount{r.Reason, r.Count})
	}
	reply := struct {
		ResourceType  string        `json:"resource_type"`
		Scope         string        `json:"scope"`
		Total         int           `json:"total"`
		Note          string        `json:"note"`
		Offset        int           `json:"offset"`
		NextOffset    *int          `json:"next_offset,omitempty"`
		NeedAttention int           `json:"need_attention"`
		Cards         interface{}   `json:"cards"`
		Phases        []podGroup    `json:"phases"`
		Statuses      []reasonCount `json:"statuses"`
		ByNamespace   []podGroup    `json:"by_namespace"`
		ByNode        []podGroup    `json:"by_node"`
		Pods          []string      `json:"pods"`
	}{
		ResourceType:  "pods",
		Scope:         scope,
		Total:         p.Stats.Total,
		NeedAttention: attention,
		Cards:         p.Stats.Health,
		Phases:        p.ByPhase,
		Statuses:      reasons,
		ByNamespace:   p.ByNamespace,
		ByNode:        p.ByNode,
		Offset:        max(offset, 0),
		Pods:          p.lines(),
	}
	reply.Note = fmt.Sprintf("%d pods in %s, too many to list at once. The counts cover every pod; pods lists %d from offset %d, "+
		"in order of need: errors and warnings first (need_attention = %d), then the rest. Call again with offset=next_offset for the next ones, "+
		"a namespace to narrow, or k8s_find_resource for a name.", p.Stats.Total, scope, len(p.Items), reply.Offset, attention)
	if next := reply.Offset + len(p.Items); next < p.Total {
		reply.NextOffset = &next
	}
	s, err := marshalJSON(reply)
	return s, true, err
}

// podsFind is k8s_find_resource's search of the pods: every pod the caller may list, by a label selector for
// key=value, else by the words of the query in the name or one label (the AI's find_pods rule, match=tokens).
// ok is false when k8s-service could not be asked (kubectl searches as before).
func podsFind(ctx context.Context, headers http.Header, query, namespace string, limit int) (matches []map[string]string, total int, note string, ok bool) {
	_, _, byLabel := strings.Cut(query, "=")
	q := url.Values{"limit": {strconv.Itoa(max(limit, 1))}}
	if byLabel {
		q.Set("label_selector", query)
	} else {
		q.Set("q", query)
		q.Set("match", "tokens")
	}
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	p, out, err := podPage(ctx, headers, q)
	if err != nil {
		if errors.Is(err, errBadRequest) {
			return nil, 0, "pods: " + err.Error(), true
		}
		return nil, 0, "", false
	}
	if out != "" {
		var refusal struct{ Status, Reason string }
		_ = json.Unmarshal([]byte(out), &refusal)
		return nil, 0, fmt.Sprintf("pods: %s (%s)", refusal.Status, refusal.Reason), true
	}
	matches = make([]map[string]string, 0, len(p.Items))
	if limit > 0 {
		for _, it := range p.Items {
			matches = append(matches, map[string]string{"kind": "pods", "name": it.Name, "namespace": it.Namespace})
		}
	}
	return matches, p.Total, "", true
}

// podsCount is k8s_count for pods grouped by nothing, the namespace, the node or the phase, from the pod rows; ok
// is false for anything else (kubectl counts it).
func podsCount(ctx context.Context, headers http.Header, args map[string]interface{}) (string, bool, error) {
	if argString(args, "field_selector", "") != "" {
		return "", false, nil
	}
	path := argString(args, "group_by", "")
	pick := map[string]func(*podPageReply) []podGroup{
		"":                    nil,
		".metadata.namespace": func(p *podPageReply) []podGroup { return p.ByNamespace },
		".spec.nodeName":      func(p *podPageReply) []podGroup { return p.ByNode },
		".status.phase":       func(p *podPageReply) []podGroup { return p.ByPhase },
	}
	groupsOf, known := pick[path]
	if !known {
		return "", false, nil
	}
	q := url.Values{"limit": {"1"}, "groups": {"1"}, "group_top": {strconv.Itoa(countGroupsCap)}}
	namespace := argString(args, "namespace", "")
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	if v := argString(args, "label_selector", ""); v != "" {
		q.Set("label_selector", v)
	}
	p, out, err := podPage(ctx, headers, q)
	if err != nil {
		if errors.Is(err, errBadRequest) {
			return "", true, err
		}
		return "", false, nil
	}
	if out != "" {
		return out, true, nil
	}
	scope := "all namespaces"
	if namespace != "" {
		scope = namespace
	}
	reply := map[string]interface{}{"resource_type": argString(args, "resource_type", ""), "scope": scope, "count": p.Total}
	if groupsOf != nil {
		type group struct {
			Key   string `json:"key"`
			Count int    `json:"count"`
		}
		var groups []group
		for _, g := range groupsOf(p) {
			switch g.Name {
			case "(other)":
				reply["truncated"] = true
				continue
			case "(none)":
				g.Name = "<none>"
			}
			groups = append(groups, group{g.Name, g.Count})
		}
		reply["group_by"] = path
		reply["groups"] = groups
	}
	s, err := marshalJSON(reply)
	return s, true, err
}
