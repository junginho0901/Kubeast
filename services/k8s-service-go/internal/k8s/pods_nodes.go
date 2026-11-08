package k8s

import (
	"context"
	"fmt"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
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
	list, err := s.podsOnNodeOf(ctx, node, namespace)
	if err != nil {
		return nil, err
	}
	return list.rows, nil
}

// podsOnNodeOf is GetPodsOnNode's read with what kubectl describe node adds up of each pod, which the Node drawer's
// Allocated Resources sum: one read of the node for everyone, as its pod table and Cluster View's box read it.
func (s *Service) podsOnNodeOf(ctx context.Context, node, namespace string) (*nodePodList, error) {
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
			list, err := s.podsOnNodeShared(ctx, b, node, namespaces, all, allowed)
			if !apierrors.IsForbidden(err) {
				return list, err
			}
		} else if !apierrors.IsForbidden(err) {
			return nil, err
		}
	}
	if b.clientset == nil {
		return nil, errNotLoaded
	}
	return nodePodsOfCaller(ctx, b.id, b.clientset.CoreV1(), node, namespaces)
}

// nodePodList is one read of a node's pods, each row with its namespace and what kubectl describe node adds up of it
// (allocationOf), in the API's order; its callers change nothing in it.
type nodePodList struct {
	rows       []map[string]interface{}
	namespaces []string
	alloc      []podAllocation
}

func nodePodListOf(items []corev1.Pod) *nodePodList {
	list := &nodePodList{rows: formatPodList(items), namespaces: make([]string, len(items)), alloc: make([]podAllocation, len(items))}
	for i := range items {
		list.namespaces[i] = items[i].Namespace
		list.alloc[i] = allocationOf(&items[i])
	}
	return list
}

// emptyNodePodList holds no pod and answers an empty list, not null.
func emptyNodePodList() *nodePodList {
	return &nodePodList{rows: []map[string]interface{}{}}
}

// keep adds from's pod i.
func (l *nodePodList) keep(from *nodePodList, i int) {
	l.rows = append(l.rows, from.rows[i])
	l.namespaces = append(l.namespaces, from.namespaces[i])
	l.alloc = append(l.alloc, from.alloc[i])
}

// keepAll adds every pod of from, which may be nil.
func (l *nodePodList) keepAll(from *nodePodList) {
	if from == nil {
		return
	}
	for i := range from.rows {
		l.keep(from, i)
	}
}

// nodeReadsAtOnce: a node of 40 pods holds about 0.7 MiB while it is read, and at the client's 100 a second a read would take over 160 ms before 16 places set the pace.
const nodeReadsAtOnce = 16

// nodeReadPlaces bound the reads of a node's pods of each cluster at once, shared or as a caller; without them the
// client's burst let 200 through together.
var nodeReadPlaces = newClusterPlaces("node pods read", nodeReadsAtOnce)

// listNodePodsAsCaller is one list of node's pods in namespace ("" = every namespace) as the caller, holding one of
// the cluster's node read places: before the informers sync, or when the shared read is refused, a crowd of callers
// costs the API server what the shared read's crowd does.
func listNodePodsAsCaller(ctx context.Context, id cluster.ID, pods typedcorev1.PodsGetter, node, namespace string) (*corev1.PodList, error) {
	release, err := nodeReadPlaces.take(ctx, id)
	if err != nil {
		return nil, err
	}
	defer release()
	return pods.Pods(namespace).List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=" + node})
}

// podsOnNodeShared keeps the shared read's pods of the allowed namespaces and lists the refused ones as the caller, in the order of namespaces.
func (s *Service) podsOnNodeShared(ctx context.Context, b *clientBundle, node string, namespaces []string, all bool, allowed []string) (*nodePodList, error) {
	list, _, err := b.nodePods.Do(ctx, node, func(ctx context.Context) (*nodePodList, error) {
		release, err := nodeReadPlaces.take(ctx, b.id)
		if err != nil {
			return nil, err
		}
		defer release()
		return readNodePods(ctx, b.cacheClient, node)
	})
	if err != nil {
		return nil, err
	}
	accesstrail.Cached(ctx, "pods on the node (read as "+overviewCacheUser+")")
	if all {
		return list, nil
	}
	refused := slices.DeleteFunc(slices.Clone(namespaces), func(ns string) bool { return slices.Contains(allowed, ns) })
	own := make([]*nodePodList, len(refused))
	if len(refused) > 0 {
		if b.clientset == nil {
			return nil, errNotLoaded
		}
		errs := make([]error, len(refused))
		sideBySide(len(refused), func(i int) {
			l, err := listNodePodsAsCaller(ctx, b.id, b.clientset.CoreV1(), node, refused[i])
			switch {
			case err == nil:
				own[i] = nodePodListOf(l.Items)
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
	out := emptyNodePodList()
	for _, ns := range namespaces {
		if i := slices.Index(refused, ns); i >= 0 {
			out.keepAll(own[i])
			continue
		}
		for j, rowNamespace := range list.namespaces {
			if rowNamespace == ns {
				out.keep(list, j)
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
	return nodePodListOf(l.Items), nil
}

// nodePodsOfCaller lists node's pods as the caller, across the cluster or in each of namespaces (one the cluster
// refuses left out unless all are, as fanOutNamespaces does), each list holding one of the cluster's node read places.
func nodePodsOfCaller(ctx context.Context, id cluster.ID, pods typedcorev1.PodsGetter, node string, namespaces []string) (*nodePodList, error) {
	list := func(ns string) ([]*nodePodList, error) {
		l, err := listNodePodsAsCaller(ctx, id, pods, node, ns)
		if err != nil {
			return nil, fmt.Errorf("list pods on node %q: %w", node, err)
		}
		return []*nodePodList{nodePodListOf(l.Items)}, nil
	}
	var parts []*nodePodList
	var err error
	if len(namespaces) == 0 {
		parts, err = list("")
	} else {
		parts, err = fanOutNamespaces(namespaces, list)
	}
	if err != nil {
		return nil, err
	}
	out := emptyNodePodList()
	for _, part := range parts {
		out.keepAll(part)
	}
	return out, nil
}

// listPodsOnNode is nodePodsOfCaller's rows.
func listPodsOnNode(ctx context.Context, id cluster.ID, pods typedcorev1.PodsGetter, node string, namespaces []string) ([]map[string]interface{}, error) {
	list, err := nodePodsOfCaller(ctx, id, pods, node, namespaces)
	if err != nil {
		return nil, err
	}
	return list.rows, nil
}
