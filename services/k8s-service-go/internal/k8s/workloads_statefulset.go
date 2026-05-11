package k8s

import (
	"context"
	"fmt"
	"sync"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== StatefulSets ==========

// GetStatefulSets lists statefulsets in a namespace.
func (s *Service) GetStatefulSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list statefulsets: %w", err)
	}
	return formatStatefulSetList(list.Items), nil
}

// GetAllStatefulSets lists statefulsets across all namespaces.
func (s *Service) GetAllStatefulSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all statefulsets: %w", err)
	}
	return formatStatefulSetList(list.Items), nil
}

// DescribeStatefulSet returns detailed info about a statefulset.
func (s *Service) DescribeStatefulSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var sts *appsv1.StatefulSet
	var events *corev1.EventList
	var stsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		sts, stsErr = s.Clientset().AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=StatefulSet", name),
		})
	}()
	wg.Wait()

	if stsErr != nil {
		return nil, fmt.Errorf("get statefulset %s/%s: %w", namespace, name, stsErr)
	}

	result := formatStatefulSetDetail(sts)

	// Additional metadata
	result["uid"] = string(sts.UID)
	result["resource_version"] = sts.ResourceVersion
	result["generation"] = sts.Generation
	result["labels"] = sts.Labels
	result["annotations"] = sts.Annotations
	if sts.Status.ObservedGeneration > 0 {
		result["observed_generation"] = sts.Status.ObservedGeneration
	}

	// StatefulSet-specific settings
	result["service_name"] = sts.Spec.ServiceName
	result["pod_management_policy"] = string(sts.Spec.PodManagementPolicy)
	if sts.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = sts.Spec.MinReadySeconds
	}
	if sts.Spec.RevisionHistoryLimit != nil {
		result["revision_history_limit"] = *sts.Spec.RevisionHistoryLimit
	}
	if sts.Status.CurrentRevision != "" {
		result["current_revision"] = sts.Status.CurrentRevision
	}
	if sts.Status.UpdateRevision != "" {
		result["update_revision"] = sts.Status.UpdateRevision
	}
	if sts.Status.CollisionCount != nil {
		result["collision_count"] = *sts.Status.CollisionCount
	}

	// Replicas status
	replicas := int32(0)
	if sts.Spec.Replicas != nil {
		replicas = *sts.Spec.Replicas
	}
	result["replicas_status"] = map[string]interface{}{
		"desired":   replicas,
		"current":   sts.Status.CurrentReplicas,
		"ready":     sts.Status.ReadyReplicas,
		"updated":   sts.Status.UpdatedReplicas,
		"available": sts.Status.AvailableReplicas,
	}

	// Selector as map
	if sts.Spec.Selector != nil && sts.Spec.Selector.MatchLabels != nil {
		result["selector"] = sts.Spec.Selector.MatchLabels
	}

	// Update strategy
	updateStrategy := map[string]interface{}{
		"type": string(sts.Spec.UpdateStrategy.Type),
	}
	if sts.Spec.UpdateStrategy.RollingUpdate != nil && sts.Spec.UpdateStrategy.RollingUpdate.Partition != nil {
		updateStrategy["rolling_update"] = map[string]interface{}{
			"partition": *sts.Spec.UpdateStrategy.RollingUpdate.Partition,
		}
	}
	result["update_strategy"] = updateStrategy

	// Pod template
	result["pod_template"] = formatPodTemplate(sts.Spec.Template)

	// Volume claim templates
	vcts := make([]map[string]interface{}, 0, len(sts.Spec.VolumeClaimTemplates))
	for _, vct := range sts.Spec.VolumeClaimTemplates {
		v := map[string]interface{}{
			"name": vct.Name,
		}
		if vct.Spec.StorageClassName != nil {
			v["storage_class_name"] = *vct.Spec.StorageClassName
		}
		v["access_modes"] = func() []string {
			modes := make([]string, 0, len(vct.Spec.AccessModes))
			for _, m := range vct.Spec.AccessModes {
				modes = append(modes, string(m))
			}
			return modes
		}()
		if vct.Spec.Resources.Requests != nil {
			req := make(map[string]string)
			for k, val := range vct.Spec.Resources.Requests {
				req[string(k)] = val.String()
			}
			v["requests"] = req
		}
		vcts = append(vcts, v)
	}
	result["volume_claim_templates"] = vcts

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(sts.Status.Conditions))
	for _, c := range sts.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	return result, nil
}

// DeleteStatefulSet deletes a statefulset.
func (s *Service) DeleteStatefulSet(ctx context.Context, namespace, name string) error {
	return s.Clientset().AppsV1().StatefulSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
