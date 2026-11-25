package k8s

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// The cluster overview used to list namespaces, pods, services, deployments,
// PVCs, PVs and nodes on every poll of every open dashboard. clusterInformers
// keeps those seven kinds in memory through list+watch instead, so the overview
// is computed from the store and is current at every poll. Objects are stripped
// to the fields the overview reads (stripForOverview) to bound memory; pods are
// kept as podRows (pod_index.go), which the Pods list pages from (pods_page.go).
//
// Lifecycle: started on the first overview request for a cluster, stopped after
// overviewIdleTimeout without a request, and with the client bundle (kubeconfig
// rotation, LRU eviction). Until the first sync completes, and while the watch
// identity is forbidden, callers fall back to List.

const (
	// overviewCacheUser is the identity the informers watch as when user
	// impersonation is on. Every managed cluster binds the viewer group
	// (files/impersonation-rbac.yaml); users may be impersonated freely.
	overviewCacheUser = "kubeast:cache"

	overviewSyncWait    = 2 * time.Second  // a request waits this long for the initial sync
	overviewIdleTimeout = 10 * time.Minute // stop the watches when nobody asks
	overviewRetryAfter  = 5 * time.Minute  // after a forbidden list/watch
)

type clusterInformers struct {
	factory informers.SharedInformerFactory
	stop    chan struct{}
	synced  chan struct{} // closed once every store has synced
	stopped sync.Once
	lastUse atomic.Int64 // unix nanoseconds
	waiting atomic.Int32 // callers in waitSynced: the set is in use while they wait, however long the sync takes

	pods                                                cache.Indexer
	namespaces, services, deployments, pvcs, pvs, nodes cache.Store

	// podRev counts changes to what a pod row shows; epoch tells this set's
	// count from the one before it (podRevision).
	podRev atomic.Uint64
	epoch  string

	// boxes holds the Cluster View box answers of whole nodes (nodeBoxJSON)
	boxes nodeBoxes

	// nodeRev counts changes to what the node list shows; the list is built
	// once per change and second and shared by every caller (nodeSummaries).
	// nodeListRows keeps each node's row and its JSON for the next build.
	nodeRev      atomic.Uint64
	nodeMu       sync.Mutex
	nodeList     *nodeList
	nodeListRev  uint64
	nodeListSec  int64
	nodeListRows nodeListRows
}

// newClusterInformers starts the seven informers on client. onStop is called
// once when the set stops on its own: idle, or forbidden=true when the identity
// may not list/watch. It is not called for stopNow.
func newClusterInformers(client kubernetes.Interface, idle time.Duration, onStop func(ci *clusterInformers, forbidden bool)) *clusterInformers {
	in := newInterner()
	f := informers.NewSharedInformerFactoryWithOptions(client, 0, informers.WithTransform(func(obj interface{}) (interface{}, error) {
		if p, ok := obj.(*corev1.Pod); ok {
			return toPodRow(p, in), nil
		}
		return stripForOverview(obj)
	}))
	ci := &clusterInformers{factory: f, stop: make(chan struct{}), synced: make(chan struct{}), epoch: strconv.FormatInt(time.Now().UnixNano(), 36)}
	ci.touch()

	infs := []cache.SharedIndexInformer{
		f.Core().V1().Pods().Informer(),
		f.Core().V1().Namespaces().Informer(),
		f.Core().V1().Services().Informer(),
		f.Apps().V1().Deployments().Informer(),
		f.Core().V1().PersistentVolumeClaims().Informer(),
		f.Core().V1().PersistentVolumes().Informer(),
		f.Core().V1().Nodes().Informer(),
	}
	// fails once the informer has stopped or holds an index of that name ("indexer conflict"); this one is new and not started
	if err := infs[0].AddIndexers(cache.Indexers{podNodeIndex: podRowNode}); err != nil {
		slog.Warn("overview informers: no node index on the pod rows", "err", err)
	}
	ci.pods, ci.namespaces, ci.services, ci.deployments, ci.pvcs, ci.pvs, ci.nodes =
		infs[0].GetIndexer(), infs[1].GetStore(), infs[2].GetStore(), infs[3].GetStore(),
		infs[4].GetStore(), infs[5].GetStore(), infs[6].GetStore()
	bump := func() { ci.podRev.Add(1) }
	podEvents, err := infs[0].AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(interface{}) { bump() },
		DeleteFunc: func(interface{}) { bump() },
		UpdateFunc: func(oldObj, newObj interface{}) {
			o, ok1 := oldObj.(*podRow)
			n, ok2 := newObj.(*podRow)
			if !ok1 || !ok2 || !o.sameView(n) {
				bump()
			}
		},
	})
	nodeBump := func() { ci.nodeRev.Add(1) }
	nodeEvents, nodeErr := infs[6].AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(interface{}) { nodeBump() },
		DeleteFunc: func(interface{}) { nodeBump() },
		UpdateFunc: func(oldObj, newObj interface{}) {
			o, ok1 := oldObj.(*corev1.Node)
			n, ok2 := newObj.(*corev1.Node)
			if !ok1 || !ok2 || !sameNodeView(o, n) {
				nodeBump()
			}
		},
	})

	var forbiddenOnce sync.Once
	for _, inf := range infs {
		_ = inf.SetWatchErrorHandlerWithContext(func(ctx context.Context, r *cache.Reflector, err error) {
			if !apierrors.IsForbidden(err) {
				cache.DefaultWatchErrorHandler(ctx, r, err)
				return
			}
			forbiddenOnce.Do(func() {
				slog.Warn("overview informers: list/watch forbidden, serving the overview by List", "err", err)
				ci.stopNow()
				if onStop != nil {
					go onStop(ci, true)
				}
			})
		})
	}

	f.Start(ci.stop)
	go func() {
		for _, ok := range f.WaitForCacheSync(ci.stop) {
			if !ok {
				return
			}
		}
		// the stores are full; the pod and node revisions are final once their handlers have had the first list too
		// (a node's first add counted after the first node list rebuilt it)
		if err == nil && !cache.WaitForCacheSync(ci.stop, podEvents.HasSynced) {
			return
		}
		if nodeErr == nil && !cache.WaitForCacheSync(ci.stop, nodeEvents.HasSynced) {
			return
		}
		close(ci.synced)
	}()

	period := idle / 4
	if period > time.Minute {
		period = time.Minute
	}
	if period <= 0 {
		period = time.Millisecond
	}
	go func() {
		t := time.NewTicker(period)
		defer t.Stop()
		for {
			select {
			case <-ci.stop:
				return
			case <-t.C:
				if ci.waiting.Load() > 0 || time.Since(ci.lastUsed()) < idle {
					continue
				}
				slog.Info("overview informers: idle, stopping")
				ci.stopNow()
				if onStop != nil {
					onStop(ci, false)
				}
				return
			}
		}
	}()
	return ci
}

func (ci *clusterInformers) touch()              { ci.lastUse.Store(time.Now().UnixNano()) }
func (ci *clusterInformers) lastUsed() time.Time { return time.Unix(0, ci.lastUse.Load()) }

// stopNow stops the watches; safe to call more than once.
func (ci *clusterInformers) stopNow() { ci.stopped.Do(func() { close(ci.stop) }) }

func (ci *clusterInformers) isStopped() bool {
	select {
	case <-ci.stop:
		return true
	default:
		return false
	}
}

func (ci *clusterInformers) isSynced() bool {
	select {
	case <-ci.synced:
		return true
	default:
		return false
	}
}

// waitSynced reports whether every store has synced, waiting up to d.
func (ci *clusterInformers) waitSynced(ctx context.Context, d time.Duration) bool {
	ci.touch()
	if ci.isSynced() {
		return !ci.isStopped()
	}
	ci.waiting.Add(1)
	defer ci.touch()
	defer ci.waiting.Add(-1)
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ci.synced:
		return !ci.isStopped()
	case <-ci.stop:
		return false
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// overview computes the dashboard summary from the stores.
func (ci *clusterInformers) overview() map[string]interface{} {
	return ci.overviewFor(nil)
}

// overviewFor counts the stores, limited to scope when a namespace-scoped
// grant asks: namespaced kinds count only inside the listed namespaces, the
// namespace count is the listed ones the cluster has, and the cluster-wide
// kinds (nodes, PVs) are reported as 0 with "scoped": true so the UI shows
// no number for them.
func (ci *clusterInformers) overviewFor(scope []string) map[string]interface{} {
	ci.touch()
	in := func(namespace string) bool { return len(scope) == 0 || containsString(scope, namespace) }
	podStatus := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
	pods := 0
	for _, o := range ci.pods.List() {
		p, ok := o.(*podRow)
		if !ok || !in(p.namespace) {
			continue
		}
		pods++
		switch corev1.PodPhase(p.phase) {
		case corev1.PodRunning:
			podStatus["Running"]++
		case corev1.PodPending:
			podStatus["Pending"]++
		case corev1.PodFailed:
			podStatus["Failed"]++
		case corev1.PodSucceeded:
			podStatus["Succeeded"]++
		default:
			podStatus["Unknown"]++
		}
	}
	if len(scope) == 0 {
		return map[string]interface{}{
			"total_namespaces":  len(ci.namespaces.ListKeys()),
			"total_pods":        pods,
			"total_services":    len(ci.services.ListKeys()),
			"total_deployments": len(ci.deployments.ListKeys()),
			"total_pvcs":        len(ci.pvcs.ListKeys()),
			"total_pvs":         len(ci.pvs.ListKeys()),
			"pod_status":        podStatus,
			"node_count":        len(ci.nodes.ListKeys()),
		}
	}
	namespaced := func(keys []string) int { // store keys are "namespace/name"
		n := 0
		for _, k := range keys {
			if i := strings.IndexByte(k, '/'); i > 0 && containsString(scope, k[:i]) {
				n++
			}
		}
		return n
	}
	return map[string]interface{}{
		"scoped":            true,
		"total_namespaces":  countIn(ci.namespaces.ListKeys(), scope),
		"total_pods":        pods,
		"total_services":    namespaced(ci.services.ListKeys()),
		"total_deployments": namespaced(ci.deployments.ListKeys()),
		"total_pvcs":        namespaced(ci.pvcs.ListKeys()),
		"total_pvs":         0,
		"pod_status":        podStatus,
		"node_count":        0,
	}
}

// nodeAllocatables returns each node's allocatable CPU and memory, what kubectl top divides by.
func (ci *clusterInformers) nodeAllocatables() map[string]nodeAllocatable {
	ci.touch()
	out := map[string]nodeAllocatable{}
	for _, o := range ci.nodes.List() {
		n, ok := o.(*corev1.Node)
		if !ok {
			continue
		}
		out[n.Name] = allocatableOf(n)
	}
	return out
}

// nodeList is one build of the node list and, encoded once when first asked,
// the JSON the handler sends: 200 people opening it at once each encoded the
// 964 KB of 1 001 nodes again. The informers' list comes with its JSON
// already put together from its rows' (nodeListRows.list).
type nodeList struct {
	items []map[string]interface{}
	once  sync.Once
	raw   []byte
}

// JSON is what json.Encoder writes for the items.
func (l *nodeList) JSON() []byte {
	l.once.Do(func() {
		if l.raw != nil {
			return
		}
		b, err := json.Marshal(l.items)
		if err != nil { // the items are strings, lists and maps of them
			b = []byte("[]")
		}
		l.raw = append(b, '\n')
	})
	return l.raw
}

// nodeSummaries is the node list — formatNodeSummary of every node, by name as
// a List returns them — built once per change and second (the age column moves
// by the second) and shared by every caller, who must not change it: 100
// people opening the node list of 1 001 nodes at once each listed and decoded
// the nodes before, 6 MiB a request. A build lists the store as before but
// makes again only the rows whose stored node was replaced or whose age reads
// differently, and keeps the list when every row reads as it did: making all
// 1 001 rows and their JSON each new second held the node list's callers behind
// nodeMu 0.2-0.4 s at a time in a crowd of 500 (2026-11-21).
func (ci *clusterInformers) nodeSummaries(now time.Time) *nodeList {
	ci.touch()
	rev, sec := ci.nodeRev.Load(), now.Unix()
	ci.nodeMu.Lock()
	defer ci.nodeMu.Unlock()
	if ci.nodeList != nil && ci.nodeListRev == rev && ci.nodeListSec == sec {
		return ci.nodeList
	}
	rows, changed := nodeListRowsOf(ci.nodes.List(), ci.nodeListRows)
	ci.nodeListRows = rows
	if changed || ci.nodeList == nil {
		ci.nodeList = rows.list()
	}
	ci.nodeListRev, ci.nodeListSec = rev, sec
	return ci.nodeList
}

// nodeListRow is one node of the node list: the stored node it was made from,
// its age as the row reads it, the row and the row's JSON (nil when
// json.Marshal refused it). A row and its JSON are not changed once made.
type nodeListRow struct {
	node *corev1.Node
	age  string
	item map[string]interface{}
	raw  []byte
}

func nodeListRowOf(n *corev1.Node) nodeListRow {
	item := formatNodeSummary(n)
	a, _ := item["age"].(string)
	raw, err := json.Marshal(item)
	if err != nil {
		raw = nil
	}
	return nodeListRow{node: n, age: a, item: item, raw: raw}
}

// nodeListRows is the node list's rows by node name, kept under nodeMu.
type nodeListRows []nodeListRow

// nodeListRowsOf is the rows of the stored nodes by name, as a List returns them,
// and whether they read differently from before. A node whose stored object is
// the one its row was made from (the store replaces an object on each update,
// and never changes one) and whose age reads the same keeps its row, since the
// age is the one field of a row that moves with the clock
// (TestTheNodeRowMovesWithTheClockOnlyInItsAge); a row made again that reads
// byte for byte as before, a heartbeat's, keeps the one before.
func nodeListRowsOf(objs []interface{}, before nodeListRows) (nodeListRows, bool) {
	nodes := make([]*corev1.Node, 0, len(objs))
	for _, o := range objs {
		if n, ok := o.(*corev1.Node); ok {
			nodes = append(nodes, n)
		}
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	out := make(nodeListRows, 0, len(nodes))
	changed := len(nodes) != len(before)
	j := 0
	for _, n := range nodes {
		for j < len(before) && before[j].node.Name < n.Name {
			j++
		}
		if j < len(before) && before[j].node.Name == n.Name {
			old := before[j]
			if old.node == n && age(&n.CreationTimestamp) == old.age {
				out = append(out, old)
				continue
			}
			if r := nodeListRowOf(n); old.raw == nil || !bytes.Equal(r.raw, old.raw) {
				out = append(out, r)
				changed = true
				continue
			}
			old.node = n
			out = append(out, old)
			continue
		}
		out = append(out, nodeListRowOf(n))
		changed = true
	}
	return out, changed
}

// list is the node list of the rows, its JSON put together from theirs: the
// bytes json.Encoder writes for the items, as json.Marshal of a list writes
// each item as json.Marshal of the item. Each row's JSON is left pointing into
// the list's, so the rows hold no copy of their own.
func (rs nodeListRows) list() *nodeList {
	items := make([]map[string]interface{}, len(rs))
	size := len("[]\n") + len(rs)
	for i := range rs {
		items[i] = rs[i].item
		if rs[i].raw == nil {
			return &nodeList{items: items, raw: []byte("[]\n")}
		}
		size += len(rs[i].raw)
	}
	raw := make([]byte, 0, size)
	raw = append(raw, '[')
	for i := range rs {
		if i > 0 {
			raw = append(raw, ',')
		}
		start := len(raw)
		raw = append(raw, rs[i].raw...)
		rs[i].raw = raw[start:len(raw):len(raw)]
	}
	raw = append(raw, ']', '\n')
	return &nodeList{items: items, raw: raw}
}

// stripNode keeps what overview, nodeAllocatables and formatNodeSummary read;
// the condition times and messages go, so a status heartbeat changes only the
// resourceVersion (sameNodeView).
func stripNode(o *corev1.Node) *corev1.Node {
	meta := keyMeta(o.ObjectMeta)
	meta.Labels, meta.CreationTimestamp = o.Labels, o.CreationTimestamp
	conds := make([]corev1.NodeCondition, len(o.Status.Conditions))
	for i, c := range o.Status.Conditions {
		conds[i] = corev1.NodeCondition{Type: c.Type, Status: c.Status, Reason: c.Reason}
	}
	info := o.Status.NodeInfo
	return &corev1.Node{
		ObjectMeta: meta,
		Spec:       corev1.NodeSpec{Unschedulable: o.Spec.Unschedulable, Taints: o.Spec.Taints},
		Status: corev1.NodeStatus{
			Capacity: o.Status.Capacity, Allocatable: o.Status.Allocatable, Conditions: conds, Addresses: o.Status.Addresses,
			NodeInfo: corev1.NodeSystemInfo{KubeletVersion: info.KubeletVersion, OSImage: info.OSImage, KernelVersion: info.KernelVersion, ContainerRuntimeVersion: info.ContainerRuntimeVersion},
		},
	}
}

// sameNodeView: two stripped nodes show the same in the node list.
func sameNodeView(a, b *corev1.Node) bool {
	ac, bc := *a, *b
	ac.ResourceVersion, bc.ResourceVersion = "", ""
	return equality.Semantic.DeepEqual(&ac, &bc)
}

// stripForOverview keeps only what overview, nodeAllocatables, the node list and
// the namespace list read; the informer stores the returned object instead of the full one. Pods
// become podRows before this (newClusterInformers).
func stripForOverview(obj interface{}) (interface{}, error) {
	switch o := obj.(type) {
	case *corev1.Node:
		return stripNode(o), nil
	case *corev1.Namespace:
		meta := keyMeta(o.ObjectMeta)
		meta.Labels, meta.CreationTimestamp = o.Labels, o.CreationTimestamp
		return &corev1.Namespace{ObjectMeta: meta, Status: corev1.NamespaceStatus{Phase: o.Status.Phase}}, nil
	case *corev1.Service:
		return &corev1.Service{ObjectMeta: keyMeta(o.ObjectMeta)}, nil
	case *appsv1.Deployment:
		return &appsv1.Deployment{ObjectMeta: keyMeta(o.ObjectMeta)}, nil
	case *corev1.PersistentVolumeClaim:
		return &corev1.PersistentVolumeClaim{ObjectMeta: keyMeta(o.ObjectMeta)}, nil
	case *corev1.PersistentVolume:
		return &corev1.PersistentVolume{ObjectMeta: keyMeta(o.ObjectMeta)}, nil
	}
	return obj, nil // cache.DeletedFinalStateUnknown and anything else
}

func keyMeta(m metav1.ObjectMeta) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: m.Name, Namespace: m.Namespace, UID: m.UID, ResourceVersion: m.ResourceVersion}
}

// overviewInformers returns the bundle's informer set, starting it on first
// use. nil when the bundle is closed, has no cache client, keeps none (noInformers) or a
// recent start was forbidden (tried again after overviewRetryAfter).
func (b *clientBundle) overviewInformers() *clusterInformers {
	b.infMu.Lock()
	defer b.infMu.Unlock()
	if b.closed {
		return nil
	}
	if b.inf != nil {
		return b.inf
	}
	if b.cacheClient == nil || b.noInformers {
		return nil
	}
	if !b.infFailedAt.IsZero() && time.Since(b.infFailedAt) < overviewRetryAfter {
		return nil
	}
	slog.Info("overview informers: starting", "cluster", b.id)
	b.inf = newClusterInformers(b.cacheClient, overviewIdleTimeout, func(ci *clusterInformers, forbidden bool) {
		slog.Info("overview informers: stopped", "cluster", b.id, "forbidden", forbidden)
		b.infMu.Lock()
		defer b.infMu.Unlock()
		if b.inf == ci {
			b.inf = nil
		}
		if forbidden {
			b.infFailedAt = time.Now()
		}
	})
	return b.inf
}

// syncedOrStart returns the running, synced informer set, or nil after starting one when there is none
// (overviewInformers: not on a closed bundle, without a cache client, with noInformers or within overviewRetryAfter of a refusal). It
// never waits for the set to sync: its caller reads as the caller meanwhile.
func (b *clientBundle) syncedOrStart() *clusterInformers {
	ci := b.overviewInformers()
	if ci == nil || !ci.isSynced() || ci.isStopped() {
		return nil
	}
	return ci
}

// syncedInformers returns the running, synced informer set or nil. It never
// starts one.
func (b *clientBundle) syncedInformers() *clusterInformers {
	b.infMu.Lock()
	defer b.infMu.Unlock()
	if b.inf != nil && b.inf.isSynced() && !b.inf.isStopped() {
		return b.inf
	}
	return nil
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// countIn counts the keys (namespace names) that are in scope.
func countIn(keys, scope []string) int {
	n := 0
	for _, k := range keys {
		if containsString(scope, k) {
			n++
		}
	}
	return n
}
