package k8s

import (
	"context"
	"fmt"
	"sync"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetDeployments lists deployments in a namespace.
func (s *Service) GetDeployments(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	depList, err := s.Clientset().AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deployments: %w", err)
	}
	return formatDeploymentList(depList.Items), nil
}

// GetAllDeployments lists deployments across all namespaces.
func (s *Service) GetAllDeployments(ctx context.Context) ([]map[string]interface{}, error) {
	depList, err := s.Clientset().AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all deployments: %w", err)
	}
	return formatDeploymentList(depList.Items), nil
}

// DescribeDeployment returns detailed info about a deployment.
func (s *Service) DescribeDeployment(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	// Fetch deployment and events in parallel
	var dep *appsv1.Deployment
	var events *corev1.EventList
	var depErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		dep, depErr = s.Clientset().AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Deployment", name),
		})
	}()
	wg.Wait()

	if depErr != nil {
		return nil, fmt.Errorf("get deployment %s/%s: %w", namespace, name, depErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatDeploymentDetail(dep)

	// Additional metadata fields for the info modal
	result["uid"] = string(dep.UID)
	result["resource_version"] = dep.ResourceVersion
	result["generation"] = dep.Generation
	result["annotations"] = dep.Annotations
	result["labels"] = dep.Labels
	if dep.Status.ObservedGeneration > 0 {
		result["observed_generation"] = dep.Status.ObservedGeneration
	}

	// Deployment-specific settings
	if dep.Spec.Paused {
		result["paused"] = true
	}
	if dep.Spec.MinReadySeconds > 0 {
		result["min_ready_seconds"] = dep.Spec.MinReadySeconds
	}
	if dep.Spec.ProgressDeadlineSeconds != nil {
		result["progress_deadline_seconds"] = *dep.Spec.ProgressDeadlineSeconds
	}
	if dep.Spec.RevisionHistoryLimit != nil {
		result["revision_history_limit"] = *dep.Spec.RevisionHistoryLimit
	}
	// Revision from annotations
	if rev, ok := dep.Annotations["deployment.kubernetes.io/revision"]; ok {
		result["revision"] = rev
	}

	// Replicas status
	replicas := int32(0)
	if dep.Spec.Replicas != nil {
		replicas = *dep.Spec.Replicas
	}
	result["replicas_status"] = map[string]interface{}{
		"desired":   replicas,
		"current":   dep.Status.Replicas,
		"ready":     dep.Status.ReadyReplicas,
		"updated":   dep.Status.UpdatedReplicas,
		"available": dep.Status.AvailableReplicas,
	}

	// Selector as map (not string)
	if dep.Spec.Selector != nil && dep.Spec.Selector.MatchLabels != nil {
		result["selector"] = dep.Spec.Selector.MatchLabels
	}

	// Strategy
	strategy := map[string]interface{}{
		"type": string(dep.Spec.Strategy.Type),
	}
	if dep.Spec.Strategy.RollingUpdate != nil {
		ru := map[string]interface{}{}
		if dep.Spec.Strategy.RollingUpdate.MaxUnavailable != nil {
			ru["max_unavailable"] = dep.Spec.Strategy.RollingUpdate.MaxUnavailable.String()
		}
		if dep.Spec.Strategy.RollingUpdate.MaxSurge != nil {
			ru["max_surge"] = dep.Spec.Strategy.RollingUpdate.MaxSurge.String()
		}
		strategy["rolling_update"] = ru
	}
	result["strategy"] = strategy

	// Pod template
	result["pod_template"] = formatPodTemplate(dep.Spec.Template)

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(dep.Status.Conditions))
	for _, c := range dep.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                   string(c.Type),
			"status":                 string(c.Status),
			"reason":                 c.Reason,
			"message":                c.Message,
			"last_transition_time":   toISO(&c.LastTransitionTime),
			"last_update_time":       toISO(&c.LastUpdateTime),
		})
	}
	result["conditions"] = conditions

	// Events
	eventList := make([]map[string]interface{}, 0, len(events.Items))
	for _, e := range events.Items {
		eventList = append(eventList, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	result["events"] = eventList

	return result, nil
}

// DeleteDeployment deletes a deployment.
func (s *Service) DeleteDeployment(ctx context.Context, namespace, name string) error {
	return s.Clientset().AppsV1().Deployments(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// formatDeploymentList formats a list of deployments.
func formatDeploymentList(deps []appsv1.Deployment) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(deps))
	for _, d := range deps {
		result = append(result, formatDeploymentDetail(&d))
	}
	return result
}

// formatDeploymentDetail formats a single deployment.
func formatDeploymentDetail(d *appsv1.Deployment) map[string]interface{} {
	replicas := int32(0)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}

	images := make([]string, 0, len(d.Spec.Template.Spec.Containers))
	for _, c := range d.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}

	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	status := "Progressing"
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentAvailable && c.Status == corev1.ConditionTrue {
			status = "Available"
			break
		}
		if c.Type == appsv1.DeploymentProgressing && c.Status == corev1.ConditionFalse {
			status = "Failed"
			break
		}
	}

	var selector interface{}
	if d.Spec.Selector != nil && d.Spec.Selector.MatchLabels != nil {
		selector = d.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	return map[string]interface{}{
		"name":               d.Name,
		"namespace":          d.Namespace,
		"replicas":           replicas,
		"ready_replicas":     d.Status.ReadyReplicas,
		"available_replicas": d.Status.AvailableReplicas,
		"updated_replicas":   d.Status.UpdatedReplicas,
		"image":              image,
		"images":             images,
		"labels":             d.Labels,
		"selector":           selector,
		"status":             status,
		"created_at":         toISO(&d.CreationTimestamp),
	}
}
