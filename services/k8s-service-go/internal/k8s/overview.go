package k8s

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/cache"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// GetClusterOverview returns a high-level summary of the cluster state, computed
// from the cluster's informer stores (informer_cache.go). Until those have
// synced, or when they cannot run, it lists the cluster (cached 30s).
//
// The stores are watched as kubeast:cache, not as the caller, so the caller's
// own cluster identity is asked first whether it may list namespaces: a custom
// role whose group the cluster has not bound, or one bound in a single
// namespace, must not be shown the whole cluster's counts.
func (s *Service) GetClusterOverview(ctx context.Context) (map[string]interface{}, error) {
	scope := scopeFromCtx(ctx)
	if b := s.bundleForCtx(ctx); b != nil {
		// A namespace-scoped grant cannot list namespaces (its group is bound
		// per namespace) and is counted inside its grant only, so the
		// cluster-wide identity check applies to unscoped callers.
		if len(scope) == 0 {
			if err := s.overviewIdentityAllowed(ctx, b); err != nil {
				return nil, err
			}
		}
		if ci := b.overviewInformers(); ci != nil && ci.waitSynced(ctx, overviewSyncWait) {
			accesstrail.Cached(ctx, "overview informers (watched as "+overviewCacheUser+")")
			ov := ci.overviewFor(scope)
			if err := s.keepListable(ctx, b, ci, scope, ov); err != nil {
				return nil, err
			}
			ov["cluster_version"] = ""
			if v, _ := b.serverVersionInfo(ctx, shownVersionTTL); v != nil {
				ov["cluster_version"] = v.GitVersion
			}
			return ov, nil
		}
	}
	cacheKey := s.clusterCacheKey(ctx, "cluster_overview")
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	var result map[string]interface{}
	var err error
	if len(scope) > 0 {
		result, err = s.getScopedOverviewUncached(ctx, scope)
	} else {
		result, err = s.getClusterOverviewUncached(ctx)
	}
	if err != nil {
		return nil, err
	}
	s.cache.Set(ctx, cacheKey, result, 30*time.Second)
	return result, nil
}

// overviewCounts are the overview's counts and the list each one is: a count the caller's identity may not list
// is null and its resource named in "refused", as kubectl as that identity is refused that list.
var overviewCounts = []struct {
	key, group, resource string
	namespaced           bool
}{
	{"total_pods", "", "pods", true},
	{"total_services", "", "services", true},
	{"total_deployments", "apps", "deployments", true},
	{"total_pvcs", "", "persistentvolumeclaims", true},
	{"total_pvs", "", "persistentvolumes", false},
	{"node_count", "", "nodes", false},
}

// refuseCount empties a count the caller may not list (the pods' phases with the pods).
func refuseCount(ov map[string]interface{}, key, resource string) {
	ov[key] = nil
	if key == "total_pods" {
		ov["pod_status"] = nil
	}
	refused, _ := ov["refused"].([]string)
	ov["refused"] = append(refused, resource)
}

// keepListable keeps the informers' counts the caller's identity may list: across the cluster, or in a scoped
// grant's namespaces (a kind listable in some of them counted there only). A scoped overview does not count the
// cluster-wide kinds.
func (s *Service) keepListable(ctx context.Context, b *clientBundle, ci *clusterInformers, scope []string, ov map[string]interface{}) error {
	if len(scope) > 0 {
		return s.keepListableIn(ctx, b, ci, scope, ov)
	}
	questions := make([]listQuestion, len(overviewCounts))
	for i, c := range overviewCounts {
		questions[i] = listQuestion{group: c.group, resource: c.resource}
	}
	answers, err := s.mayListAll(ctx, b, questions)
	if err != nil {
		return err
	}
	for i, c := range overviewCounts {
		if !answers[i] {
			refuseCount(ov, c.key, c.resource)
		}
	}
	return nil
}

// keepListableIn is keepListable for a grant limited to namespaces. A namespace that holds none of a kind adds nothing
// to its count, so whether the caller may list the kind there only decides between 0 and refused: the namespaces that
// hold some are asked, and the others only while none of the kind's answers allowed it (the first of them when no
// namespace holds the kind, the rest in a second round). Every count is the namespaces' counts as read once, added up
// over the namespaces whose answer allowed it, so a namespace not asked is one that added nothing.
func (s *Service) keepListableIn(ctx context.Context, b *clientBundle, ci *clusterInformers, scope []string, ov map[string]interface{}) error {
	counts := ci.namespaceCounts(scope)
	type kind struct {
		key, group, resource string
		asked, allowed       []string
	}
	var kinds []*kind
	for _, c := range overviewCounts {
		if c.namespaced {
			kinds = append(kinds, &kind{key: c.key, group: c.group, resource: c.resource})
		}
	}
	ask := func(next func(k *kind) []string) error {
		var questions []listQuestion
		var of []*kind
		for _, k := range kinds {
			for _, ns := range next(k) {
				k.asked = append(k.asked, ns)
				questions = append(questions, listQuestion{group: k.group, resource: k.resource, namespace: ns})
				of = append(of, k)
			}
		}
		if len(questions) == 0 {
			return nil
		}
		answers, err := s.mayListAll(ctx, b, questions)
		if err != nil {
			return err
		}
		for i, q := range questions {
			if answers[i] {
				of[i].allowed = append(of[i].allowed, q.namespace)
			}
		}
		return nil
	}
	holding := func(k *kind, holds bool) []string {
		var out []string
		for _, ns := range scope {
			if (counts[ns].of[k.key] > 0) == holds && !slices.Contains(k.asked, ns) && !slices.Contains(out, ns) {
				out = append(out, ns)
			}
		}
		return out
	}
	if err := ask(func(k *kind) []string {
		if held := holding(k, true); len(held) > 0 {
			return held
		}
		empty := holding(k, false)
		return empty[:min(1, len(empty))]
	}); err != nil {
		return err
	}
	if err := ask(func(k *kind) []string {
		if len(k.allowed) > 0 {
			return nil
		}
		return holding(k, false)
	}); err != nil {
		return err
	}
	for _, k := range kinds {
		if len(k.allowed) == 0 {
			refuseCount(ov, k.key, k.resource)
			continue
		}
		n := 0
		for _, ns := range k.allowed {
			n += counts[ns].of[k.key]
		}
		ov[k.key] = n
		if k.key == "total_pods" {
			phases := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
			for _, ns := range k.allowed {
				for phase, m := range counts[ns].phases {
					phases[phase] += m
				}
			}
			ov["pod_status"] = phases
		}
	}
	return nil
}

// scopeCount is one namespace's counts of the overview's namespaced kinds, by the overview's key, and its pods by phase.
type scopeCount struct {
	of     map[string]int
	phases map[string]int
}

// namespaceCounts reads each namespace of scope's counts from the stores, as overviewFor counts them.
func (ci *clusterInformers) namespaceCounts(scope []string) map[string]scopeCount {
	ci.touch()
	out := make(map[string]scopeCount, len(scope))
	for _, ns := range scope {
		c := scopeCount{of: map[string]int{}, phases: map[string]int{}}
		pods, _ := ci.pods.ByIndex(cache.NamespaceIndex, ns)
		for _, o := range pods {
			if p, ok := o.(*podRow); ok {
				c.of["total_pods"]++
				c.phases[overviewPhase(p.phase)]++
			}
		}
		out[ns] = c
	}
	for key, store := range map[string]cache.Store{"total_services": ci.services, "total_deployments": ci.deployments, "total_pvcs": ci.pvcs} {
		for _, k := range store.ListKeys() { // "namespace/name"
			if i := strings.IndexByte(k, '/'); i > 0 {
				if c, ok := out[k[:i]]; ok {
					c.of[key]++
				}
			}
		}
	}
	return out
}

// overviewPhase is the pod_status key a pod's phase counts under.
func overviewPhase(phase string) string {
	switch corev1.PodPhase(phase) {
	case corev1.PodRunning, corev1.PodPending, corev1.PodFailed, corev1.PodSucceeded:
		return phase
	default:
		return "Unknown"
	}
}

func (s *Service) getClusterOverviewUncached(ctx context.Context) (map[string]interface{}, error) {
	nsList, err := s.clientsetCtx(ctx).CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	result := map[string]interface{}{"total_namespaces": len(nsList.Items)}
	// a list the caller is refused is a count it may not see (null, named in "refused"), not a failed overview
	count := func(key, resource string, n func() int, err error) error {
		switch {
		case apierrors.IsForbidden(err):
			refuseCount(result, key, resource)
		case err != nil:
			return fmt.Errorf("list %s: %w", resource, err)
		default:
			result[key] = n()
		}
		return nil
	}

	// the pods counted a page at a time (every pod in one list took k8s-service past 512 Mi)
	podStatus := map[string]int{
		"Running":   0,
		"Pending":   0,
		"Failed":    0,
		"Succeeded": 0,
		"Unknown":   0,
	}
	totalPods := 0
	err = eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), "", metav1.ListOptions{}, func(p *corev1.Pod) {
		totalPods++
		switch p.Status.Phase {
		case "Running", "Pending", "Failed", "Succeeded":
			podStatus[string(p.Status.Phase)]++
		default:
			podStatus["Unknown"]++
		}
	})
	result["pod_status"] = podStatus
	if err := count("total_pods", "pods", func() int { return totalPods }, err); err != nil {
		return nil, err
	}
	cs := s.clientsetCtx(ctx)
	opts := metav1.ListOptions{}
	svc, err := cs.CoreV1().Services("").List(ctx, opts)
	if err := count("total_services", "services", func() int { return len(svc.Items) }, err); err != nil {
		return nil, err
	}
	dep, err := cs.AppsV1().Deployments("").List(ctx, opts)
	if err := count("total_deployments", "deployments", func() int { return len(dep.Items) }, err); err != nil {
		return nil, err
	}
	pvc, err := cs.CoreV1().PersistentVolumeClaims("").List(ctx, opts)
	if err := count("total_pvcs", "persistentvolumeclaims", func() int { return len(pvc.Items) }, err); err != nil {
		return nil, err
	}
	pv, err := cs.CoreV1().PersistentVolumes().List(ctx, opts)
	if err := count("total_pvs", "persistentvolumes", func() int { return len(pv.Items) }, err); err != nil {
		return nil, err
	}
	nodes, err := cs.CoreV1().Nodes().List(ctx, opts)
	if err := count("node_count", "nodes", func() int { return len(nodes.Items) }, err); err != nil {
		return nil, err
	}

	clusterVersion := ""
	sv, err := s.clusterVersion(ctx)
	if err == nil {
		clusterVersion = sv.GitVersion
	}
	result["cluster_version"] = clusterVersion
	return result, nil
}

// GetComponentStatuses returns Kubernetes component statuses.
// Deprecated since K8s 1.19+ - returns empty list for newer clusters.
func (s *Service) GetComponentStatuses(ctx context.Context) ([]map[string]interface{}, error) {
	csList, err := s.clientsetCtx(ctx).CoreV1().ComponentStatuses().List(ctx, metav1.ListOptions{})
	if err != nil {
		slog.Warn("componentstatuses not available (deprecated since K8s 1.19+)", "err", err)
		return []map[string]interface{}{}, nil
	}

	result := make([]map[string]interface{}, 0, len(csList.Items))
	for _, cs := range csList.Items {
		conditions := make([]map[string]interface{}, 0, len(cs.Conditions))
		for _, c := range cs.Conditions {
			conditions = append(conditions, map[string]interface{}{
				"type":    string(c.Type),
				"status":  string(c.Status),
				"message": c.Message,
				"error":   c.Error,
			})
		}
		result = append(result, map[string]interface{}{
			"name":       cs.Name,
			"conditions": conditions,
		})
	}
	return result, nil
}

var errOverviewForbidden = apierrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, "",
	errors.New("your identity in this cluster may not list namespaces, so the cluster overview is not shown"))

// overviewIdentityAllowed asks whether the caller may list namespaces (mayListShown, the namespace list's question too).
func (s *Service) overviewIdentityAllowed(ctx context.Context, b *clientBundle) error {
	allowed, err := s.mayListShown(ctx, b, "", "namespaces", "")
	if err != nil {
		return err
	}
	if !allowed {
		return errOverviewForbidden
	}
	return nil
}

// getScopedOverviewUncached counts a namespace-scoped caller's namespaces
// one by one (the cluster refuses the all-namespaces lists for them).
func (s *Service) getScopedOverviewUncached(ctx context.Context, scope []string) (map[string]interface{}, error) {
	podStatus := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
	totals := map[string]int{}
	listed := map[string]bool{} // a kind the cluster let the caller list in at least one namespace of the grant
	note := func(key string, n int, err error) {
		if apierrors.IsForbidden(err) {
			return
		}
		totals[key] += n
		listed[key] = true
	}
	namespaces := 0
	for _, ns := range scope {
		cs := s.clientsetCtx(ctx)
		if _, err := cs.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{}); err == nil {
			namespaces++
		}
		// counted a page at a time; a namespace refused part-way counts what was read
		pods := 0
		err := eachPod(ctx, cs.CoreV1(), ns, metav1.ListOptions{}, func(p *corev1.Pod) {
			pods++
			switch p.Status.Phase {
			case "Running", "Pending", "Failed", "Succeeded":
				podStatus[string(p.Status.Phase)]++
			default:
				podStatus["Unknown"]++
			}
		})
		totals["total_pods"] += pods
		note("total_pods", 0, err)
		svc, err := cs.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		note("total_services", lenIfListed(err, func() int { return len(svc.Items) }), err)
		dep, err := cs.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		note("total_deployments", lenIfListed(err, func() int { return len(dep.Items) }), err)
		pvc, err := cs.CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		note("total_pvcs", lenIfListed(err, func() int { return len(pvc.Items) }), err)
	}
	result := map[string]interface{}{
		"scoped":           true,
		"total_namespaces": namespaces,
		"pod_status":       podStatus,
		"total_pvs":        0,
		"node_count":       0,
	}
	for _, c := range overviewCounts {
		if !c.namespaced {
			continue
		}
		if listed[c.key] {
			result[c.key] = totals[c.key]
		} else {
			refuseCount(result, c.key, c.resource)
		}
	}
	return result, nil
}

// lenIfListed is n() when the list came back, else 0.
func lenIfListed(err error, n func() int) int {
	if err != nil {
		return 0
	}
	return n()
}
