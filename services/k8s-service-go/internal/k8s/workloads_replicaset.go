package k8s

import (
	"context"
	"fmt"
	"sync"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== ReplicaSets ==========

// GetReplicaSets lists replicasets in a namespace.
func (s *Service) GetReplicaSets(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list replicasets: %w", err)
	}
	return formatReplicaSetList(list.Items), nil
}

// GetAllReplicaSets lists replicasets across all namespaces.
func (s *Service) GetAllReplicaSets(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().AppsV1().ReplicaSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all replicasets: %w", err)
	}
	return formatReplicaSetList(list.Items), nil
}

// DescribeReplicaSet returns detailed info about a replicaset.
func (s *Service) DescribeReplicaSet(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var rs *appsv1.ReplicaSet
	var events *corev1.EventList
	var rsErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		rs, rsErr = s.Clientset().AppsV1().ReplicaSets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ReplicaSet", name),
		})
	}()
	wg.Wait()

	if rsErr != nil {
		return nil, fmt.Errorf("get replicaset %s/%s: %w", namespace, name, rsErr)
	}

	result := formatReplicaSetDetail(rs)

	// Additional metadata
	result["uid"] = string(rs.UID)
	result["resource_version"] = rs.ResourceVersion
	result["generation"] = rs.Generation
	result["labels"] = rs.Labels
	result["annotations"] = rs.Annotations

	// ReplicaSet-specific settings
	if rs.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = rs.Spec.MinReadySeconds
	}
	result["fully_labeled_replicas"] = rs.Status.FullyLabeledReplicas

	// Owner
	for _, or := range rs.OwnerReferences {
		if or.Kind == "Deployment" {
			result["owner"] = or.Name
			break
		}
	}

	// Revision from annotations
	if rev, ok := rs.Annotations["deployment.kubernetes.io/revision"]; ok {
		result["revision"] = rev
	}

	// Selector as map
	if rs.Spec.Selector != nil && rs.Spec.Selector.MatchLabels != nil {
		result["selector"] = rs.Spec.Selector.MatchLabels
	}

	// Pod template
	result["pod_template"] = formatPodTemplate(rs.Spec.Template)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(rs.Status.Conditions))
	for _, c := range rs.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Owner references
	owners := make([]map[string]interface{}, 0, len(rs.OwnerReferences))
	for _, or := range rs.OwnerReferences {
		owners = append(owners, map[string]interface{}{
			"kind": or.Kind,
			"name": or.Name,
			"uid":  string(or.UID),
		})
	}
	result["owner_references"] = owners

	return result, nil
}

// DeleteReplicaSet deletes a replicaset.
func (s *Service) DeleteReplicaSet(ctx context.Context, namespace, name string) error {
	return s.Clientset().AppsV1().ReplicaSets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}
