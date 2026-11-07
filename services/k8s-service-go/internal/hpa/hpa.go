// Package hpa is a HorizontalPodAutoscaler as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package hpa

import (
	"fmt"
	"time"

	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Info is the HPA's row: its target, replica counts and metrics, each with what the controller last read of it.
// min_replicas and last_scale_time are in it only while the object has them.
func Info(h *autoscalingv2.HorizontalPodAutoscaler) map[string]interface{} {
	metrics := make([]map[string]interface{}, 0, len(h.Spec.Metrics))
	for i, m := range h.Spec.Metrics {
		spec := MetricSpec(m)
		if i < len(h.Status.CurrentMetrics) {
			spec["current"] = MetricStatus(h.Status.CurrentMetrics[i])
		}
		metrics = append(metrics, spec)
	}

	scalingActive := false
	for _, c := range h.Status.Conditions {
		if c.Type == autoscalingv2.ScalingActive {
			scalingActive = c.Status == corev1.ConditionTrue
		}
	}

	result := map[string]interface{}{
		"name":             h.Name,
		"namespace":        h.Namespace,
		"target_ref":       fmt.Sprintf("%s/%s", h.Spec.ScaleTargetRef.Kind, h.Spec.ScaleTargetRef.Name),
		"target_ref_kind":  h.Spec.ScaleTargetRef.Kind,
		"target_ref_name":  h.Spec.ScaleTargetRef.Name,
		"max_replicas":     h.Spec.MaxReplicas,
		"current_replicas": h.Status.CurrentReplicas,
		"desired_replicas": h.Status.DesiredReplicas,
		"scaling_active":   scalingActive,
		"metrics":          metrics,
		"labels":           h.Labels,
		"created_at":       iso(&h.CreationTimestamp),
	}
	if h.Spec.MinReplicas != nil {
		result["min_replicas"] = *h.Spec.MinReplicas
	}
	if h.Status.LastScaleTime != nil {
		result["last_scale_time"] = iso(h.Status.LastScaleTime)
	}
	return result
}

func iso(t *metav1.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// MetricSpec is one metric the HPA asks for: its name and target.
func MetricSpec(m autoscalingv2.MetricSpec) map[string]interface{} {
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

// MetricStatus is what the controller last read of one metric.
func MetricStatus(m autoscalingv2.MetricStatus) map[string]interface{} {
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
