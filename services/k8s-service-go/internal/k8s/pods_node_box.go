package k8s

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// A Cluster View node box draws each of its node's pods as a card: the name, the namespace, the colour and its reason,
// the restarts, and what the box's search reads (the node and the pod IP); its menu's Delete asks for the name of a pod
// its labels mark as Helm's (systemObject). The box gets only those, from the overview informers' rows on its node
// (podNodeIndex), as Kubernetes' own controllers look up a node's pods; the pod's window reads the pod itself when it
// is opened from such a row, as an object's details are read in Headlamp, Freelens and Rancher when their list does
// not hold them.

// nodeBoxPod is a pod as a node box draws it. Each field is the field of the same name in the pod's full row
// (podrow.Info), and health is the card colour the row keeps (podHealth, held to the page's getPodHealth by
// podHealth.cases.json).
type nodeBoxPod struct {
	Name         string            `json:"name"`
	Namespace    string            `json:"namespace"`
	NodeName     string            `json:"node_name"`
	PodIP        string            `json:"pod_ip"`
	Status       string            `json:"status"`
	Phase        string            `json:"phase"`
	RestartCount int32             `json:"restart_count"`
	CreatedAt    string            `json:"created_at"`
	Labels       map[string]string `json:"labels"`
	Health       string            `json:"health"`
	HealthReason string            `json:"health_reason"`
}

var podHealthLevels = [...]string{podHealthOK: "ok", podHealthWarn: "warn", podHealthError: "error"}

func boxPodOf(r *podRow) nodeBoxPod {
	created := ""
	if r.created != 0 {
		created = time.Unix(r.created, 0).UTC().Format(time.RFC3339)
	}
	return nodeBoxPod{
		Name: r.name, Namespace: r.namespace, NodeName: r.node, PodIP: r.podIP, Status: r.status, Phase: r.phase,
		RestartCount: r.restarts, CreatedAt: created, Labels: labelMap(r.labels), Health: podHealthLevels[r.health], HealthReason: r.healthReason,
	}
}

// labelMap is a row's labels (podLabelPairs) as the pod has them; nil for none, as a pod without labels has.
func labelMap(pairs string) map[string]string {
	if pairs == "" {
		return nil
	}
	out := make(map[string]string, strings.Count(pairs, "\x1e")+1)
	for pair := range strings.SplitSeq(pairs, "\x1e") {
		k, v, _ := strings.Cut(pair, "\x1f")
		out[k] = v
	}
	return out
}

// boxPodsOf is the listed pods as a box draws them.
func boxPodsOf(items []corev1.Pod) []nodeBoxPod {
	in := newInterner()
	out := make([]nodeBoxPod, len(items))
	for i := range items {
		out[i] = boxPodOf(toPodRow(&items[i], in))
	}
	return out
}

// boxJSON is what response.JSON writes for pods: an empty list as [], not null.
func boxJSON(pods []nodeBoxPod) []byte {
	if pods == nil {
		pods = []nodeBoxPod{}
	}
	b, err := json.Marshal(pods)
	if err != nil { // strings and numbers only
		b = []byte("[]")
	}
	return append(b, '\n')
}

// GetPodsOnNodeJSON is a node box's answer: the pods on node ("" = not scheduled) the caller's own list shows in
// namespace ("" = every namespace it may see), as nodeBoxPods in the API's order. With the overview informers synced
// they are the rows on that node, kept to the namespaces the caller's identity may list pods in (podListAccess) and a
// namespace that check refuses listed as the caller; before the informers sync, or once kubeast:cache may not watch
// pods (they stop), the node is listed as the caller. Every list as the caller holds one of the node read places.
func (s *Service) GetPodsOnNodeJSON(ctx context.Context, node, namespace string) ([]byte, error) {
	b := s.bundleForCtx(ctx)
	if b == nil {
		return nil, errNotLoaded
	}
	namespaces, err := callerNamespaces(ctx, namespace)
	if err != nil {
		return nil, err
	}
	// running informers say kubeast:cache may watch pods; waiting for a start would make this read slower than the caller's own
	if ci := b.syncedInformers(); ci != nil {
		all, allowed, err := s.podListAccess(ctx, b, namespace)
		if err == nil {
			if raw, ok, err := s.nodeBoxOfRows(ctx, b, ci, node, namespaces, all, allowed); ok {
				return raw, err
			}
		} else if !apierrors.IsForbidden(err) {
			return nil, err
		}
	}
	if b.clientset == nil {
		return nil, errNotLoaded
	}
	parts, err := listNodePodsOfCaller(ctx, b.id, b.clientset.CoreV1(), node, namespaces, boxPodsOf)
	if err != nil {
		return nil, err
	}
	return boxJSON(slices.Concat(parts...)), nil
}

// nodeBoxOfRows is the box's answer from the rows on node, kept to the allowed namespaces of namespaces (all: every
// one) and those refused listed as the caller, in the order of namespaces; not ok without the node index.
func (s *Service) nodeBoxOfRows(ctx context.Context, b *clientBundle, ci *clusterInformers, node string, namespaces []string, all bool, allowed []string) ([]byte, bool, error) {
	rows, ok := ci.nodeRows(node)
	if !ok {
		return nil, false, nil
	}
	accesstrail.Cached(ctx, "pod rows (watched as "+overviewCacheUser+")")
	if all {
		return ci.nodeBoxJSON(node, rows), true, nil
	}
	refused := slices.DeleteFunc(slices.Clone(namespaces), func(ns string) bool { return slices.Contains(allowed, ns) })
	own, err := refusedAsCaller(ctx, b, node, refused, boxPodsOf)
	if err != nil {
		return nil, true, err
	}
	out := make([]nodeBoxPod, 0, len(rows))
	for _, ns := range namespaces {
		if i := slices.Index(refused, ns); i >= 0 {
			out = append(out, own[i]...)
			continue
		}
		for _, r := range rows {
			if r.namespace == ns {
				out = append(out, boxPodOf(r))
			}
		}
	}
	return boxJSON(out), true, nil
}

// nodeRows is the rows on node in the API's order (namespace, then name); the caller only reads them. Not ok when the
// store has no node index.
func (ci *clusterInformers) nodeRows(node string) ([]*podRow, bool) {
	ci.touch()
	objs, err := ci.pods.ByIndex(podNodeIndex, node)
	if err != nil {
		return nil, false
	}
	rows := make([]*podRow, 0, len(objs))
	for _, o := range objs {
		if r, ok := o.(*podRow); ok {
			rows = append(rows, r)
		}
	}
	slices.SortFunc(rows, apiOrder)
	return rows, true
}

// nodeBoxes keeps, per node, the box answer of every pod on it, which every caller who may see every namespace gets:
// many people opening the same page of boxes get bytes made once, as the node list's (nodeList.JSON). An answer is
// used while the node's rows are the ones it was made of; the informer stores a new row for every update it takes, so
// a pod changed, added, moved away or deleted makes the next answer anew. At most nodeBoxesKept nodes are kept.
type nodeBoxes struct {
	mu    sync.Mutex
	nodes map[string]*nodeBox
}

type nodeBox struct {
	rows []*podRow
	raw  []byte
}

// nodeBoxesKept: an answer of 40 pods is about 12 KB, so a full set holds some 3 MB.
const nodeBoxesKept = 256

// nodeBoxJSON is the answer of rows, the node's rows in the API's order, made once while they stay the same.
func (ci *clusterInformers) nodeBoxJSON(node string, rows []*podRow) []byte {
	ci.boxes.mu.Lock()
	kept := ci.boxes.nodes[node]
	ci.boxes.mu.Unlock()
	if kept != nil && slices.Equal(kept.rows, rows) {
		return kept.raw
	}
	pods := make([]nodeBoxPod, len(rows))
	for i, r := range rows {
		pods[i] = boxPodOf(r)
	}
	made := &nodeBox{rows: rows, raw: boxJSON(pods)}
	ci.boxes.mu.Lock()
	defer ci.boxes.mu.Unlock()
	if ci.boxes.nodes == nil {
		ci.boxes.nodes = map[string]*nodeBox{}
	}
	if _, ok := ci.boxes.nodes[node]; !ok && len(ci.boxes.nodes) >= nodeBoxesKept {
		for other := range ci.boxes.nodes {
			delete(ci.boxes.nodes, other)
			break
		}
	}
	ci.boxes.nodes[node] = made
	return made.raw
}
