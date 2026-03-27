package k8s

import (
	"context"
	"fmt"
	"sync"

	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetHPAs lists HPAs in a namespace.
func (s *Service) GetHPAs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientset.AutoscalingV2().HorizontalPodAutoscalers(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list hpas: %w", err)
	}
	return formatHPAList(list.Items), nil
}

// GetAllHPAs lists HPAs across all namespaces.
func (s *Service) GetAllHPAs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.AutoscalingV2().HorizontalPodAutoscalers("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all hpas: %w", err)
	}
	return formatHPAList(list.Items), nil
}

// DescribeHPA returns detailed info about an HPA.
func (s *Service) DescribeHPA(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var hpa *autoscalingv2.HorizontalPodAutoscaler
	var events *corev1.EventList
	var hpaErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		hpa, hpaErr = s.clientset.AutoscalingV2().HorizontalPodAutoscalers(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=HorizontalPodAutoscaler", name),
		})
	}()
	wg.Wait()

	if hpaErr != nil {
		return nil, fmt.Errorf("get hpa %s/%s: %w", namespace, name, hpaErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatHPADetail(hpa)

	// Additional metadata
	result["uid"] = string(hpa.UID)
	result["resource_version"] = hpa.ResourceVersion
	result["generation"] = hpa.Generation
	result["annotations"] = hpa.Annotations
	result["labels"] = hpa.Labels

	// Scale target ref
	result["scale_target_ref"] = map[string]interface{}{
		"kind":        hpa.Spec.ScaleTargetRef.Kind,
		"name":        hpa.Spec.ScaleTargetRef.Name,
		"api_version": hpa.Spec.ScaleTargetRef.APIVersion,
	}

	// Behavior
	if hpa.Spec.Behavior != nil {
		behavior := map[string]interface{}{}
		if hpa.Spec.Behavior.ScaleUp != nil {
			behavior["scale_up"] = formatHPAScalingRules(hpa.Spec.Behavior.ScaleUp)
		}
		if hpa.Spec.Behavior.ScaleDown != nil {
			behavior["scale_down"] = formatHPAScalingRules(hpa.Spec.Behavior.ScaleDown)
		}
		result["behavior"] = behavior
	}

	// Metrics spec
	metricsSpec := make([]map[string]interface{}, 0, len(hpa.Spec.Metrics))
	for _, m := range hpa.Spec.Metrics {
		metricsSpec = append(metricsSpec, formatMetricSpec(m))
	}
	result["metrics_spec"] = metricsSpec

	// Current metrics status
	metricsStatus := make([]map[string]interface{}, 0, len(hpa.Status.CurrentMetrics))
	for _, m := range hpa.Status.CurrentMetrics {
		metricsStatus = append(metricsStatus, formatMetricStatus(m))
	}
	result["metrics_status"] = metricsStatus

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(hpa.Status.Conditions))
	for _, c := range hpa.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":              string(c.Status),
			"reason":              c.Reason,
			"message":             c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
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

// DeleteHPA deletes an HPA.
func (s *Service) DeleteHPA(ctx context.Context, namespace, name string) error {
	return s.clientset.AutoscalingV2().HorizontalPodAutoscalers(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatHPAList(hpas []autoscalingv2.HorizontalPodAutoscaler) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(hpas))
	for i := range hpas {
		result = append(result, formatHPADetail(&hpas[i]))
	}
	return result
}

func formatHPADetail(hpa *autoscalingv2.HorizontalPodAutoscaler) map[string]interface{} {
	targetRef := fmt.Sprintf("%s/%s", hpa.Spec.ScaleTargetRef.Kind, hpa.Spec.ScaleTargetRef.Name)

	var minReplicas *int32
	if hpa.Spec.MinReplicas != nil {
		minReplicas = hpa.Spec.MinReplicas
	}

	// Format metrics for list view
	metrics := make([]map[string]interface{}, 0, len(hpa.Spec.Metrics))
	for i, m := range hpa.Spec.Metrics {
		spec := formatMetricSpec(m)
		// Merge with current status if available
		if i < len(hpa.Status.CurrentMetrics) {
			status := formatMetricStatus(hpa.Status.CurrentMetrics[i])
			spec["current"] = status
		}
		metrics = append(metrics, spec)
	}

	result := map[string]interface{}{
		"name":             hpa.Name,
		"namespace":        hpa.Namespace,
		"target_ref":       targetRef,
		"target_ref_kind":  hpa.Spec.ScaleTargetRef.Kind,
		"target_ref_name":  hpa.Spec.ScaleTargetRef.Name,
		"max_replicas":     hpa.Spec.MaxReplicas,
		"current_replicas": hpa.Status.CurrentReplicas,
		"desired_replicas": hpa.Status.DesiredReplicas,
		"metrics":          metrics,
		"labels":           hpa.Labels,
		"created_at":       toISO(&hpa.CreationTimestamp),
	}

	if minReplicas != nil {
		result["min_replicas"] = *minReplicas
	}

	if hpa.Status.LastScaleTime != nil {
		result["last_scale_time"] = toISO(hpa.Status.LastScaleTime)
	}

	return result
}

func formatMetricSpec(m autoscalingv2.MetricSpec) map[string]interface{} {
	result := map[string]interface{}{
		"type": string(m.Type),
	}

	switch m.Type {
	case autoscalingv2.ResourceMetricSourceType:
		if m.Resource != nil {
			result["resource_name"] = string(m.Resource.Name)
			if m.Resource.Target.Type == autoscalingv2.UtilizationMetricType && m.Resource.Target.AverageUtilization != nil {
				result["target_average_utilization"] = *m.Resource.Target.AverageUtilization
				result["target_type"] = "Utilization"
			} else if m.Resource.Target.AverageValue != nil {
				result["target_average_value"] = m.Resource.Target.AverageValue.String()
				result["target_type"] = "AverageValue"
			} else if m.Resource.Target.Value != nil {
				result["target_value"] = m.Resource.Target.Value.String()
				result["target_type"] = "Value"
			}
		}
	case autoscalingv2.PodsMetricSourceType:
		if m.Pods != nil {
			result["metric_name"] = m.Pods.Metric.Name
			if m.Pods.Target.AverageValue != nil {
				result["target_average_value"] = m.Pods.Target.AverageValue.String()
			}
		}
	case autoscalingv2.ObjectMetricSourceType:
		if m.Object != nil {
			result["metric_name"] = m.Object.Metric.Name
			result["described_object"] = map[string]interface{}{
				"kind":        m.Object.DescribedObject.Kind,
				"name":        m.Object.DescribedObject.Name,
				"api_version": m.Object.DescribedObject.APIVersion,
			}
			if m.Object.Target.Value != nil {
				result["target_value"] = m.Object.Target.Value.String()
			}
			if m.Object.Target.AverageValue != nil {
				result["target_average_value"] = m.Object.Target.AverageValue.String()
			}
		}
	case autoscalingv2.ExternalMetricSourceType:
		if m.External != nil {
			result["metric_name"] = m.External.Metric.Name
			if m.External.Target.Value != nil {
				result["target_value"] = m.External.Target.Value.String()
			}
			if m.External.Target.AverageValue != nil {
				result["target_average_value"] = m.External.Target.AverageValue.String()
			}
		}
	case autoscalingv2.ContainerResourceMetricSourceType:
		if m.ContainerResource != nil {
			result["resource_name"] = string(m.ContainerResource.Name)
			result["container"] = m.ContainerResource.Container
			if m.ContainerResource.Target.AverageUtilization != nil {
				result["target_average_utilization"] = *m.ContainerResource.Target.AverageUtilization
				result["target_type"] = "Utilization"
			} else if m.ContainerResource.Target.AverageValue != nil {
				result["target_average_value"] = m.ContainerResource.Target.AverageValue.String()
				result["target_type"] = "AverageValue"
			}
		}
	}

	return result
}

func formatMetricStatus(m autoscalingv2.MetricStatus) map[string]interface{} {
	result := map[string]interface{}{
		"type": string(m.Type),
	}

	switch m.Type {
	case autoscalingv2.ResourceMetricSourceType:
		if m.Resource != nil {
			result["resource_name"] = string(m.Resource.Name)
			if m.Resource.Current.AverageUtilization != nil {
				result["current_average_utilization"] = *m.Resource.Current.AverageUtilization
			}
			if m.Resource.Current.AverageValue != nil {
				result["current_average_value"] = m.Resource.Current.AverageValue.String()
			}
		}
	case autoscalingv2.PodsMetricSourceType:
		if m.Pods != nil {
			result["metric_name"] = m.Pods.Metric.Name
			if m.Pods.Current.AverageValue != nil {
				result["current_average_value"] = m.Pods.Current.AverageValue.String()
			}
		}
	case autoscalingv2.ObjectMetricSourceType:
		if m.Object != nil {
			result["metric_name"] = m.Object.Metric.Name
			if m.Object.Current.Value != nil {
				result["current_value"] = m.Object.Current.Value.String()
			}
			if m.Object.Current.AverageValue != nil {
				result["current_average_value"] = m.Object.Current.AverageValue.String()
			}
		}
	case autoscalingv2.ExternalMetricSourceType:
		if m.External != nil {
			result["metric_name"] = m.External.Metric.Name
			if m.External.Current.Value != nil {
				result["current_value"] = m.External.Current.Value.String()
			}
			if m.External.Current.AverageValue != nil {
				result["current_average_value"] = m.External.Current.AverageValue.String()
			}
		}
	case autoscalingv2.ContainerResourceMetricSourceType:
		if m.ContainerResource != nil {
			result["resource_name"] = string(m.ContainerResource.Name)
			result["container"] = m.ContainerResource.Container
			if m.ContainerResource.Current.AverageUtilization != nil {
				result["current_average_utilization"] = *m.ContainerResource.Current.AverageUtilization
			}
			if m.ContainerResource.Current.AverageValue != nil {
				result["current_average_value"] = m.ContainerResource.Current.AverageValue.String()
			}
		}
	}

	return result
}

func formatHPAScalingRules(rules *autoscalingv2.HPAScalingRules) map[string]interface{} {
	result := map[string]interface{}{}
	if rules.StabilizationWindowSeconds != nil {
		result["stabilization_window_seconds"] = *rules.StabilizationWindowSeconds
	}
	if rules.SelectPolicy != nil {
		result["select_policy"] = string(*rules.SelectPolicy)
	}
	policies := make([]map[string]interface{}, 0, len(rules.Policies))
	for _, p := range rules.Policies {
		policies = append(policies, map[string]interface{}{
			"type":           string(p.Type),
			"value":          p.Value,
			"period_seconds": p.PeriodSeconds,
		})
	}
	result["policies"] = policies
	return result
}
