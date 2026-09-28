package k8s

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// The cluster overview used to list namespaces, pods, services, deployments,
// PVCs, PVs and nodes on every poll of every open dashboard. clusterInformers
// keeps those seven kinds in memory through list+watch instead, so the overview
// is computed from the store and is current at every poll. Objects are stripped
// to the fields the overview reads (stripForOverview) to bound memory.
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

	pods, namespaces, services, deployments, pvcs, pvs, nodes cache.Store

	versionMu sync.Mutex
	version   string
	versionAt time.Time
}

// newClusterInformers starts the seven informers on client. onStop is called
// once when the set stops on its own: idle, or forbidden=true when the identity
// may not list/watch. It is not called for stopNow.
func newClusterInformers(client kubernetes.Interface, idle time.Duration, onStop func(ci *clusterInformers, forbidden bool)) *clusterInformers {
	f := informers.NewSharedInformerFactoryWithOptions(client, 0, informers.WithTransform(stripForOverview))
	ci := &clusterInformers{factory: f, stop: make(chan struct{}), synced: make(chan struct{})}
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
	ci.pods, ci.namespaces, ci.services, ci.deployments, ci.pvcs, ci.pvs, ci.nodes =
		infs[0].GetStore(), infs[1].GetStore(), infs[2].GetStore(), infs[3].GetStore(),
		infs[4].GetStore(), infs[5].GetStore(), infs[6].GetStore()

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
				if time.Since(ci.lastUsed()) < idle {
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
	ci.touch()
	podStatus := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
	pods := ci.pods.List()
	for _, o := range pods {
		p, ok := o.(*corev1.Pod)
		if !ok {
			continue
		}
		switch p.Status.Phase {
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
	return map[string]interface{}{
		"total_namespaces":  len(ci.namespaces.ListKeys()),
		"total_pods":        len(pods),
		"total_services":    len(ci.services.ListKeys()),
		"total_deployments": len(ci.deployments.ListKeys()),
		"total_pvcs":        len(ci.pvcs.ListKeys()),
		"total_pvs":         len(ci.pvs.ListKeys()),
		"pod_status":        podStatus,
		"node_count":        len(ci.nodes.ListKeys()),
	}
}

// nodeCapacities returns each node's CPU (nanocores) and memory (bytes) capacity.
func (ci *clusterInformers) nodeCapacities() map[string]nodeCapacity {
	ci.touch()
	out := map[string]nodeCapacity{}
	for _, o := range ci.nodes.List() {
		n, ok := o.(*corev1.Node)
		if !ok {
			continue
		}
		out[n.Name] = nodeCapacity{
			cpuNano:  n.Status.Capacity.Cpu().MilliValue() * 1000000,
			memBytes: n.Status.Capacity.Memory().Value(),
		}
	}
	return out
}

// serverVersion returns the cluster's GitVersion, refreshed every 10 minutes.
func (ci *clusterInformers) serverVersion(disc discovery.DiscoveryInterface) string {
	ci.versionMu.Lock()
	defer ci.versionMu.Unlock()
	if disc == nil || (ci.version != "" && time.Since(ci.versionAt) < 10*time.Minute) {
		return ci.version
	}
	if sv, err := disc.ServerVersion(); err == nil {
		ci.version, ci.versionAt = sv.GitVersion, time.Now()
	}
	return ci.version
}

// stripForOverview keeps only what overview and nodeCapacities read; the
// informer stores the returned object instead of the full one.
func stripForOverview(obj interface{}) (interface{}, error) {
	switch o := obj.(type) {
	case *corev1.Pod:
		return &corev1.Pod{ObjectMeta: keyMeta(o.ObjectMeta), Status: corev1.PodStatus{Phase: o.Status.Phase}}, nil
	case *corev1.Node:
		return &corev1.Node{ObjectMeta: keyMeta(o.ObjectMeta), Status: corev1.NodeStatus{Capacity: o.Status.Capacity}}, nil
	case *corev1.Namespace:
		return &corev1.Namespace{ObjectMeta: keyMeta(o.ObjectMeta)}, nil
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
// use. nil when the bundle has no cache client or a recent start was forbidden
// (tried again after overviewRetryAfter).
func (b *clientBundle) overviewInformers() *clusterInformers {
	b.infMu.Lock()
	defer b.infMu.Unlock()
	if b.inf != nil {
		return b.inf
	}
	if b.cacheClient == nil {
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
