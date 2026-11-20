package k8s

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// rolloutRS is what the Timeline's rows read of a ReplicaSet that can be a rollout: one with an owner of kind
// Deployment and a revision. The rest of it, its pod template most of all, is not kept.
type rolloutRS struct {
	namespace   string
	created     metav1.Time
	deployments []string // its owners of kind Deployment, in order
	revision    int64
	changeCause string
	replicas    int32
	images      []string
}

// ownerKey is an owner by kind and name.
type ownerKey struct{ kind, name string }

// rolloutCR is what the rows read of a ControllerRevision of a StatefulSet or a DaemonSet: its images taken from its
// data, which is not kept.
type rolloutCR struct {
	namespace  string
	created    metav1.Time
	revision   int64
	images     []string
	controller ownerKey   // its controlling owner when that is a StatefulSet or a DaemonSet
	owners     []ownerKey // its owners of those kinds
}

// keptReplicaSet is rs as the rows read it; false when it can be no rollout.
func keptReplicaSet(rs *appsv1.ReplicaSet) (rolloutRS, bool) {
	var deployments []string
	for _, ref := range rs.OwnerReferences {
		if ref.Kind == "Deployment" {
			deployments = append(deployments, ref.Name)
		}
	}
	revStr, ok := rs.Annotations["deployment.kubernetes.io/revision"]
	if len(deployments) == 0 || !ok {
		return rolloutRS{}, false
	}
	rev, err := strconv.ParseInt(revStr, 10, 64)
	if err != nil {
		return rolloutRS{}, false
	}
	kept := rolloutRS{
		namespace:   rs.Namespace,
		created:     rs.CreationTimestamp,
		deployments: deployments,
		revision:    rev,
		changeCause: rs.Annotations["kubernetes.io/change-cause"],
		images:      extractContainerImages(rs.Spec.Template.Spec.Containers),
	}
	if rs.Spec.Replicas != nil {
		kept.replicas = *rs.Spec.Replicas
	}
	return kept, true
}

// keptRevision is cr as the rows read it; false when no StatefulSet or DaemonSet owns it.
func keptRevision(cr *appsv1.ControllerRevision) (rolloutCR, bool) {
	kept := rolloutCR{namespace: cr.Namespace, created: cr.CreationTimestamp, revision: cr.Revision}
	if c := metav1.GetControllerOfNoCopy(cr); c != nil && (c.Kind == "StatefulSet" || c.Kind == "DaemonSet") {
		kept.controller = ownerKey{c.Kind, c.Name}
	}
	for _, ref := range cr.OwnerReferences {
		if ref.Kind == "StatefulSet" || ref.Kind == "DaemonSet" {
			kept.owners = append(kept.owners, ownerKey{ref.Kind, ref.Name})
		}
	}
	if len(kept.owners) == 0 {
		return rolloutCR{}, false
	}
	kept.images = extractImagesFromControllerRevision(cr)
	return kept, true
}

// row is the Timeline's row of the rollout rs is, under the Deployment name in namespace.
func (rs *rolloutRS) row(name, namespace string) map[string]interface{} {
	return map[string]interface{}{
		"kind":         "Deployment",
		"name":         name,
		"namespace":    namespace,
		"revision":     rs.revision,
		"change_cause": nilIfEmpty(rs.changeCause),
		"created_at":   toISO(&rs.created),
		"images":       rs.images,
		"replicas":     rs.replicas,
	}
}

// row is the Timeline's row of the rollout cr is, of the workload kind and name in namespace.
func (cr *rolloutCR) row(kind, name, namespace string) map[string]interface{} {
	return map[string]interface{}{
		"kind":         kind,
		"name":         name,
		"namespace":    namespace,
		"revision":     cr.revision,
		"change_cause": nil,
		"created_at":   toISO(&cr.created),
		"images":       cr.images,
		"replicas":     0,
	}
}

// readRolloutDeployments is every Deployment of namespace ("" for all) by namespace/name, read as client a page at a time.
func readRolloutDeployments(ctx context.Context, client kubernetes.Interface, namespace string) (map[string]bool, error) {
	keys := map[string]bool{}
	err := eachRolloutPage(ctx, func(o metav1.ListOptions) (*appsv1.DeploymentList, error) {
		return client.AppsV1().Deployments(namespace).List(ctx, o)
	}, func(page *appsv1.DeploymentList) {
		for i := range page.Items {
			keys[page.Items[i].Namespace+"/"+page.Items[i].Name] = true
		}
	})
	if err != nil {
		return nil, err
	}
	return keys, nil
}

// readRolloutReplicaSets is the ReplicaSets of namespace created at or after cutoff (all when zero) that can be
// rollouts, in the order listed, read as client a page at a time.
func readRolloutReplicaSets(ctx context.Context, client kubernetes.Interface, namespace string, cutoff time.Time) ([]rolloutRS, error) {
	var kept []rolloutRS
	err := eachRolloutPage(ctx, func(o metav1.ListOptions) (*appsv1.ReplicaSetList, error) {
		return client.AppsV1().ReplicaSets(namespace).List(ctx, o)
	}, func(page *appsv1.ReplicaSetList) {
		for i := range page.Items {
			if rs, ok := keptReplicaSet(&page.Items[i]); ok && !rs.created.Time.Before(cutoff) {
				kept = append(kept, rs)
			}
		}
	})
	if err != nil {
		return nil, err
	}
	return kept, nil
}

// readRolloutRevisions is the ControllerRevisions of namespace created at or after cutoff (all when zero) that a
// StatefulSet or a DaemonSet owns, in the order listed, read as client a page at a time.
func readRolloutRevisions(ctx context.Context, client kubernetes.Interface, namespace string, cutoff time.Time) ([]rolloutCR, error) {
	var kept []rolloutCR
	err := eachRolloutPage(ctx, func(o metav1.ListOptions) (*appsv1.ControllerRevisionList, error) {
		return client.AppsV1().ControllerRevisions(namespace).List(ctx, o)
	}, func(page *appsv1.ControllerRevisionList) {
		for i := range page.Items {
			if cr, ok := keptRevision(&page.Items[i]); ok && !cr.created.Time.Before(cutoff) {
				kept = append(kept, cr)
			}
		}
	})
	if err != nil {
		return nil, err
	}
	return kept, nil
}

// since is items created at or after cutoff, in their order: what the caller's own read with cutoff keeps. The items
// are copies whose slices are the window's, to read and not to change.
func since[T any](items []T, created func(*T) time.Time, cutoff time.Time) []T {
	var out []T
	for i := range items {
		if !created(&items[i]).Before(cutoff) {
			out = append(out, items[i])
		}
	}
	return out
}

// rolloutDeployments is every Deployment of namespace, from one read for everyone whose identity may list them there
// (rolloutWindow), else read as the caller.
func (s *Service) rolloutDeployments(ctx context.Context, namespace string) (map[string]bool, error) {
	b := s.bundleForCtx(ctx)
	keys, shared, err := rolloutWindow(ctx, s, b, b.deploymentWindowsOf(), "deployments", namespace, readRolloutDeployments)
	if err != nil || shared {
		return keys, err
	}
	return readRolloutDeployments(ctx, s.clientsetCtx(ctx), namespace)
}

// rolloutReplicaSets is readRolloutReplicaSets for the caller, cut from one read for everyone whose identity may list
// them there (rolloutWindow), else read as the caller.
func (s *Service) rolloutReplicaSets(ctx context.Context, namespace string, cutoff time.Time) ([]rolloutRS, error) {
	b := s.bundleForCtx(ctx)
	all, shared, err := rolloutWindow(ctx, s, b, b.replicaSetWindowsOf(), "replicasets", namespace,
		func(ctx context.Context, client kubernetes.Interface, namespace string) ([]rolloutRS, error) {
			return readRolloutReplicaSets(ctx, client, namespace, time.Time{})
		})
	if err != nil {
		return nil, err
	}
	if shared {
		return since(all, func(rs *rolloutRS) time.Time { return rs.created.Time }, cutoff), nil
	}
	return readRolloutReplicaSets(ctx, s.clientsetCtx(ctx), namespace, cutoff)
}

// rolloutRevisions is readRolloutRevisions for the caller, cut from one read for everyone whose identity may list them
// there (rolloutWindow), else read as the caller.
func (s *Service) rolloutRevisions(ctx context.Context, namespace string, cutoff time.Time) ([]rolloutCR, error) {
	b := s.bundleForCtx(ctx)
	all, shared, err := rolloutWindow(ctx, s, b, b.revisionWindowsOf(), "controllerrevisions", namespace,
		func(ctx context.Context, client kubernetes.Interface, namespace string) ([]rolloutCR, error) {
			return readRolloutRevisions(ctx, client, namespace, time.Time{})
		})
	if err != nil {
		return nil, err
	}
	if shared {
		return since(all, func(cr *rolloutCR) time.Time { return cr.created.Time }, cutoff), nil
	}
	return readRolloutRevisions(ctx, s.clientsetCtx(ctx), namespace, cutoff)
}

func (b *clientBundle) deploymentWindowsOf() *flight.Group[map[string]bool] {
	if b == nil {
		return nil
	}
	return &b.deploymentWindows
}

func (b *clientBundle) replicaSetWindowsOf() *flight.Group[[]rolloutRS] {
	if b == nil {
		return nil
	}
	return &b.replicaSetWindows
}

func (b *clientBundle) revisionWindowsOf() *flight.Group[[]rolloutCR] {
	if b == nil {
		return nil
	}
	return &b.revisionWindows
}

// rolloutWindow is resource (an apps kind the Timeline's rollouts read) of namespace read once as kubeast:cache for
// everyone asking at that moment whose identity may list it there (SelfSubjectAccessReview through mayListGroup, 60 s):
// what that identity's own list gives. The run that answers a caller started after it asked (reads). shared false says
// to read as the caller: no cache identity, a caller limited to namespaces asking for all of them, a review that
// refuses or fails, or kubeast:cache refused resource there within the last minute.
func rolloutWindow[T any](ctx context.Context, s *Service, b *clientBundle, reads *flight.Group[T], resource, namespace string,
	read func(ctx context.Context, client kubernetes.Interface, namespace string) (T, error)) (T, bool, error) {
	var none T
	if b == nil || b.cacheClient == nil || (namespace == "" && len(scopeFromCtx(ctx)) > 0) || rolloutsRefusedTo(b, resource, namespace) {
		return none, false, nil
	}
	// a review the cluster did not answer says nothing of the caller's rights: its own read answers, as before the review
	if may, err := s.mayListGroup(ctx, b, "apps", resource, namespace); err != nil || !may {
		return none, false, nil
	}
	w, _, err := reads.Do(ctx, namespace, func(ctx context.Context) (T, error) {
		// none of the caller's values but the record of its calls: kubeast:cache's own identity
		plain, cancel := context.WithCancel(carryClusterCalls(context.Background(), ctx))
		defer context.AfterFunc(ctx, cancel)()
		defer cancel()
		return read(plain, b.cacheClient, namespace)
	})
	if apierrors.IsForbidden(err) {
		b.rolloutsRefused.Store(resource+"\x00"+namespace, time.Now().Add(accessCheckTTL()))
		return none, false, nil
	}
	if err != nil {
		// a caller that left while waiting gets its context's error, which says nothing of the list
		if ctxErr := ctx.Err(); ctxErr != nil && err == ctxErr {
			return none, false, fmt.Errorf("%s not listed: %w", resource, err)
		}
		return none, false, err
	}
	where := "the cluster"
	if namespace != "" {
		where = "namespace " + namespace
	}
	accesstrail.Cached(ctx, resource+" of "+where+" (read as "+overviewCacheUser+")")
	return w, true, nil
}

// rolloutsRefusedTo says whether kubeast:cache was refused resource in namespace within the last minute.
func rolloutsRefusedTo(b *clientBundle, resource, namespace string) bool {
	until, ok := b.rolloutsRefused.Load(resource + "\x00" + namespace)
	return ok && time.Now().Before(until.(time.Time))
}

// deploymentRolloutRows pairs each ReplicaSet with its owning Deployment, the first of its Deployment owners among
// deployments: keyed by namespace/name, as with every namespace both lists span the cluster, and a ReplicaSet may only
// be owned by a Deployment in its own namespace. Newest first.
func deploymentRolloutRows(deployments map[string]bool, sets []rolloutRS) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range sets {
		rs := &sets[i]
		if owner := slices.IndexFunc(rs.deployments, func(name string) bool { return deployments[rs.namespace+"/"+name] }); owner >= 0 {
			result = append(result, rs.row(rs.deployments[owner], rs.namespace))
		}
	}
	sortRolloutRowsByTime(result)
	return result
}

// revisionRolloutRows is each ControllerRevision whose controlling owner is a StatefulSet or a DaemonSet, by that owner.
func revisionRolloutRows(revisions []rolloutCR) []map[string]interface{} {
	result := make([]map[string]interface{}, 0)
	for i := range revisions {
		if c := revisions[i].controller; c.kind != "" {
			result = append(result, revisions[i].row(c.kind, c.name, revisions[i].namespace))
		}
	}
	return result
}
