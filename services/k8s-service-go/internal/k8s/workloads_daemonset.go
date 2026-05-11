package k8s

import (
	"context"
	"fmt"
	"sync"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== DaemonSets ==========

// GetDaemonSets lists daemonsets in a namespace.
func (s *Service) GetDaemonSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list daemonsets: %w", err)
	}
	return formatDaemonSetList(list.Items), nil
}

// GetAllDaemonSets lists daemonsets across all namespaces.
func (s *Service) GetAllDaemonSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all daemonsets: %w", err)
	}
	return formatDaemonSetList(list.Items), nil
}

// DescribeDaemonSet returns detailed info about a daemonset.
func (s *Service) DescribeDaemonSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var ds *appsv1.DaemonSet
	var events *corev1.EventList
	var dsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		ds, dsErr = s.Clientset().AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=DaemonSet", name),
		})
	}()
	wg.Wait()

	if dsErr != nil {
		return nil, fmt.Errorf("get daemonset %s/%s: %w", namespace, name, dsErr)
	}

	result := formatDaemonSetDetail(ds)

	// Additional metadata
	result["uid"] = string(ds.UID)
	result["resource_version"] = ds.ResourceVersion
	result["generation"] = ds.Generation
	result["labels"] = ds.Labels
	result["annotations"] = ds.Annotations
	if ds.Status.ObservedGeneration > 0 {
		result["observed_generation"] = ds.Status.ObservedGeneration
	}

	// DaemonSet-specific settings
	if ds.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = ds.Spec.MinReadySeconds
	}
	if ds.Spec.RevisionHistoryLimit != nil {
		result["revision_history_limit"] = *ds.Spec.RevisionHistoryLimit
	}
	if ds.Status.CollisionCount != nil {
		result["collision_count"] = *ds.Status.CollisionCount
	}
	result["daemonset_status"] = map[string]interface{}{
		"desired":      ds.Status.DesiredNumberScheduled,
		"current":      ds.Status.CurrentNumberScheduled,
		"ready":        ds.Status.NumberReady,
		"updated":      ds.Status.UpdatedNumberScheduled,
		"available":    ds.Status.NumberAvailable,
		"misscheduled": ds.Status.NumberMisscheduled,
		"unavailable":  ds.Status.NumberUnavailable,
	}

	// Selector as map
	if ds.Spec.Selector != nil && ds.Spec.Selector.MatchLabels != nil {
		result["selector"] = ds.Spec.Selector.MatchLabels
	}

	// Update strategy
	updateStrategy := map[string]interface{}{
		"type": string(ds.Spec.UpdateStrategy.Type),
	}
	if ds.Spec.UpdateStrategy.RollingUpdate != nil && ds.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable != nil {
		updateStrategy["rolling_update"] = map[string]interface{}{
			"max_unavailable": ds.Spec.UpdateStrategy.RollingUpdate.MaxUnavailable.String(),
		}
	}
	result["update_strategy"] = updateStrategy

	// Pod template
	result["pod_template"] = formatPodTemplate(ds.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(ds.Status.Conditions))
	for _, c := range ds.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Owned pods (Pods whose ownerReferences include this DaemonSet)
	if ownedPods, err := s.listOwnedPods(ctx, namespace, "DaemonSet", name); err == nil {
		result["owned_pods"] = ownedPods
	}

	return result, nil
}

// DeleteDaemonSet deletes a daemonset.
func (s *Service) DeleteDaemonSet(ctx context.Context, namespace, name string) error {
	return s.Clientset().AppsV1().DaemonSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
