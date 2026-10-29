package k8s

import (
	"context"
	"fmt"
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
)

// Cluster View draws every node with its pods as coloured dots (the node map)
// and fetches the pods of the nodes on screen only. The map is counted from
// the pod rows (pod_index.go) with the caller's access, the colours as the
// page's cards (podHealth); a node's pods are listed as the caller.

// PodNodeCount is one node's pods on the map; Node "" is the pods not yet
// scheduled.
type PodNodeCount struct {
	Node  string `json:"node"`
	Total int    `json:"total"`
	OK    int    `json:"ok"`
	Warn  int    `json:"warn"`
	Error int    `json:"error"`
}

type PodNodeSummary struct {
	Nodes     []PodNodeCount `json:"nodes"` // nodes with at least one pod that matched, by name
	Total     int            `json:"total"` // pods that matched
	All       int            `json:"all"`   // pods of the namespace choice, before the search
	Revision  string         `json:"revision"`
	Unchanged bool           `json:"unchanged,omitempty"`
	Source    string         `json:"source"`
}

// GetPodNodeSummary counts the caller's pods per node in namespace ("" =
// every namespace it may see) whose name or namespace has q, as the page's
// search did.
func (s *Service) GetPodNodeSummary(ctx context.Context, namespace, q, revision string) (*PodNodeSummary, error) {
	set, err := s.callerPodRows(ctx, namespace, revision)
	if err != nil {
		return nil, err
	}
	if set.unchanged {
		return &PodNodeSummary{Nodes: []PodNodeCount{}, Revision: set.revision, Unchanged: true, Source: set.source}, nil
	}
	sum := podNodeSummary(set.rows, q)
	sum.Revision, sum.Source = set.revision, set.source
	return sum, nil
}

func podNodeSummary(rows []*podRow, q string) *PodNodeSummary {
	needle := strings.ToLower(strings.TrimSpace(q))
	byNode := map[string]*PodNodeCount{}
	total := 0
	for _, r := range rows {
		if needle != "" && !strings.Contains(r.name, needle) && !strings.Contains(r.namespace, needle) {
			continue
		}
		c := byNode[r.node]
		if c == nil {
			c = &PodNodeCount{Node: r.node}
			byNode[r.node] = c
		}
		c.Total++
		switch r.health {
		case podHealthError:
			c.Error++
		case podHealthWarn:
			c.Warn++
		default:
			c.OK++
		}
		total++
	}
	out := &PodNodeSummary{Nodes: make([]PodNodeCount, 0, len(byNode)), Total: total, All: len(rows)}
	for _, c := range byNode {
		out.Nodes = append(out.Nodes, *c)
	}
	slices.SortFunc(out.Nodes, func(a, b PodNodeCount) int { return strings.Compare(a.Node, b.Node) })
	return out
}

// GetPodsOnNode lists the pods on node ("" = not scheduled) as the caller:
// in namespace when one is chosen, else every namespace it may list (a
// namespace-scoped grant lists each of its namespaces, as listAcrossNamespaces).
func (s *Service) GetPodsOnNode(ctx context.Context, node, namespace string) ([]map[string]interface{}, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, errNotLoaded
	}
	namespaces, err := callerNamespaces(ctx, namespace)
	if err != nil {
		return nil, err
	}
	return listPodsOnNode(ctx, cs.CoreV1(), node, namespaces)
}

func listPodsOnNode(ctx context.Context, pods typedcorev1.PodsGetter, node string, namespaces []string) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{FieldSelector: "spec.nodeName=" + node}
	list := func(ns string) ([]map[string]interface{}, error) {
		l, err := pods.Pods(ns).List(ctx, opts)
		if err != nil {
			return nil, fmt.Errorf("list pods on node %q: %w", node, err)
		}
		return formatPodList(l.Items), nil
	}
	if len(namespaces) == 0 {
		return list("")
	}
	return fanOutNamespaces(namespaces, list)
}
