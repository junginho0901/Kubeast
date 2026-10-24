package k8s

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// overviewIdentityTTL is how long a cluster's answer about one identity is kept.
const overviewIdentityTTL = 60 * time.Second

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
			ov["cluster_version"] = ci.serverVersion(b.discovery)
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

func (s *Service) getClusterOverviewUncached(ctx context.Context) (map[string]interface{}, error) {
	nsList, err := s.clientsetCtx(ctx).CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}

	podList, err := s.clientsetCtx(ctx).CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}

	svcList, err := s.clientsetCtx(ctx).CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}

	depList, err := s.clientsetCtx(ctx).AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deployments: %w", err)
	}

	pvcList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvcs: %w", err)
	}

	pvList, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvs: %w", err)
	}

	nodeList, err := s.clientsetCtx(ctx).CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list nodes: %w", err)
	}

	podStatus := map[string]int{
		"Running":   0,
		"Pending":   0,
		"Failed":    0,
		"Succeeded": 0,
		"Unknown":   0,
	}
	for _, p := range podList.Items {
		switch p.Status.Phase {
		case "Running":
			podStatus["Running"]++
		case "Pending":
			podStatus["Pending"]++
		case "Failed":
			podStatus["Failed"]++
		case "Succeeded":
			podStatus["Succeeded"]++
		default:
			podStatus["Unknown"]++
		}
	}

	clusterVersion := ""
	sv, err := s.clientsetCtx(ctx).Discovery().ServerVersion()
	if err == nil {
		clusterVersion = sv.GitVersion
	}

	return map[string]interface{}{
		"total_namespaces":  len(nsList.Items),
		"total_pods":        len(podList.Items),
		"total_services":    len(svcList.Items),
		"total_deployments": len(depList.Items),
		"total_pvcs":        len(pvcList.Items),
		"total_pvs":         len(pvList.Items),
		"pod_status":        podStatus,
		"node_count":        len(nodeList.Items),
		"cluster_version":   clusterVersion,
	}, nil
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

// overviewIdentityAllowed answers from the cache (per cluster and identity,
// overviewIdentityTTL) or asks the cluster through b.mayListNamespaces.
func (s *Service) overviewIdentityAllowed(ctx context.Context, b *clientBundle) error {
	key := s.clusterCacheKey(ctx, "overview_identity")
	var allowed bool
	if s.cache != nil && s.cache.Get(ctx, key, &allowed) {
		if allowed {
			return nil
		}
		return errOverviewForbidden
	}
	allowed, err := b.mayListNamespaces(ctx)
	if err != nil {
		return err
	}
	if s.cache != nil {
		s.cache.Set(ctx, key, allowed, overviewIdentityTTL)
	}
	if !allowed {
		return errOverviewForbidden
	}
	return nil
}

// mayListNamespaces is a SelfSubjectAccessReview for "list namespaces" as the
// caller (the impersonated identity the bundle's clients carry).
func (b *clientBundle) mayListNamespaces(ctx context.Context) (bool, error) {
	if b.authz == nil {
		return true, nil
	}
	review, err := b.authz.SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
		Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: "list", Resource: "namespaces"}},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	return review.Status.Allowed, nil
}

// getScopedOverviewUncached counts a namespace-scoped caller's namespaces
// one by one (the cluster refuses the all-namespaces lists for them).
func (s *Service) getScopedOverviewUncached(ctx context.Context, scope []string) (map[string]interface{}, error) {
	podStatus := map[string]int{"Running": 0, "Pending": 0, "Failed": 0, "Succeeded": 0, "Unknown": 0}
	totalPods, totalServices, totalDeployments, totalPVCs, namespaces := 0, 0, 0, 0, 0
	for _, ns := range scope {
		cs := s.clientsetCtx(ctx)
		if _, err := cs.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{}); err == nil {
			namespaces++
		}
		if pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{}); err == nil {
			totalPods += len(pods.Items)
			for _, p := range pods.Items {
				switch p.Status.Phase {
				case "Running", "Pending", "Failed", "Succeeded":
					podStatus[string(p.Status.Phase)]++
				default:
					podStatus["Unknown"]++
				}
			}
		}
		if l, err := cs.CoreV1().Services(ns).List(ctx, metav1.ListOptions{}); err == nil {
			totalServices += len(l.Items)
		}
		if l, err := cs.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{}); err == nil {
			totalDeployments += len(l.Items)
		}
		if l, err := cs.CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{}); err == nil {
			totalPVCs += len(l.Items)
		}
	}
	return map[string]interface{}{
		"scoped":            true,
		"total_namespaces":  namespaces,
		"total_pods":        totalPods,
		"total_services":    totalServices,
		"total_deployments": totalDeployments,
		"total_pvcs":        totalPVCs,
		"total_pvs":         0,
		"pod_status":        podStatus,
		"node_count":        0,
	}, nil
}
