package k8s

import (
	"context"
	"fmt"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// Cluster View draws every node with its pods as coloured dots (the node map)
// and fetches the pods of the nodes on screen only. The map is counted from
// the pod rows (pod_index.go) with the caller's access, the colours as the
// page's cards (podHealth); a node's pods are read once for everyone asking
// as kubeast:cache and kept to what the caller's identity may list.

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
	defer set.done()
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

// GetPodsOnNode is the pods on node ("" = not scheduled) the caller's own list shows, from one read for everyone as kubeast:cache kept to what its identity may list (podListAccess), what that check refuses listed as the caller.
func (s *Service) GetPodsOnNode(ctx context.Context, node, namespace string) ([]map[string]interface{}, error) {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	namespaces, err := callerNamespaces(ctx, namespace)
	if err != nil {
		return nil, err
	}
	// running informers say kubeast:cache may read pods; waiting for a start would make this read slower than the caller's own
	if ci := b.syncedInformers(); ci != nil {
		ci.touch()
		all, allowed, err := s.podListAccess(ctx, b, namespace)
		if err == nil {
			rows, err := s.podsOnNodeShared(ctx, b, node, namespaces, all, allowed)
			if !apierrors.IsForbidden(err) {
				return rows, err
			}
		} else if !apierrors.IsForbidden(err) {
			return nil, err
		}
	}
	if b.clientset == nil {
		return nil, errNotLoaded
	}
	return listPodsOnNode(ctx, b.clientset.CoreV1(), node, namespaces)
}

// nodePodList is one read of a node's pods, each row with its namespace in the API's order; its callers change nothing in it.
type nodePodList struct {
	rows       []map[string]interface{}
	namespaces []string
}

// podsOnNodeShared keeps the shared read's rows of the allowed namespaces and lists the refused ones as the caller, in the order of namespaces.
func (s *Service) podsOnNodeShared(ctx context.Context, b *clientBundle, node string, namespaces []string, all bool, allowed []string) ([]map[string]interface{}, error) {
	list, _, err := b.nodePods.Do(ctx, node, func(ctx context.Context) (*nodePodList, error) {
		return readNodePods(ctx, b.cacheClient, node)
	})
	if err != nil {
		return nil, err
	}
	accesstrail.Cached(ctx, "pods on the node (read as "+overviewCacheUser+")")
	if all {
		return list.rows, nil
	}
	refused := slices.DeleteFunc(slices.Clone(namespaces), func(ns string) bool { return slices.Contains(allowed, ns) })
	own := make([][]map[string]interface{}, len(refused))
	if len(refused) > 0 {
		if b.clientset == nil {
			return nil, errNotLoaded
		}
		errs := make([]error, len(refused))
		sideBySide(len(refused), func(i int) {
			l, err := b.clientset.CoreV1().Pods(refused[i]).List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=" + node})
			switch {
			case err == nil:
				own[i] = formatPodList(l.Items)
			case !apierrors.IsForbidden(err) && !apierrors.IsNotFound(err):
				errs[i] = fmt.Errorf("list pods on node %q: %w", node, err)
			}
		})
		for _, err := range errs {
			if err != nil {
				return nil, err
			}
		}
	}
	out := make([]map[string]interface{}, 0, len(list.rows))
	for _, ns := range namespaces {
		if i := slices.Index(refused, ns); i >= 0 {
			out = append(out, own[i]...)
			continue
		}
		for j, rowNamespace := range list.namespaces {
			if rowNamespace == ns {
				out = append(out, list.rows[j])
			}
		}
	}
	return out, nil
}

// readNodePods lists node's pods in every namespace as client, with none of the caller's values: client's own identity.
func readNodePods(ctx context.Context, client kubernetes.Interface, node string) (*nodePodList, error) {
	plain, cancel := context.WithCancel(context.Background())
	defer context.AfterFunc(ctx, cancel)()
	defer cancel()
	l, err := client.CoreV1().Pods("").List(plain, metav1.ListOptions{FieldSelector: "spec.nodeName=" + node})
	if err != nil {
		return nil, fmt.Errorf("list pods on node %q: %w", node, err)
	}
	list := &nodePodList{rows: formatPodList(l.Items), namespaces: make([]string, len(l.Items))}
	for i := range l.Items {
		list.namespaces[i] = l.Items[i].Namespace
	}
	return list, nil
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
