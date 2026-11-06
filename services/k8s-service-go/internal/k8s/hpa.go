package k8s

import (
	"context"
	"fmt"
	"sync"

	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	hparow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/hpa"
)

// GetHPAs lists HPAs in a namespace.
func (s *Service) GetHPAs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list hpas: %w", err)
	}
	return formatHPAList(list.Items), nil
}

// GetAllHPAs lists HPAs across all namespaces.
func (s *Service) GetAllHPAs(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all hpas: %w", err)
		}
		return formatHPAList(list.Items), nil
	})
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
		hpa, hpaErr = s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=HorizontalPodAutoscaler", name),
		})
	}()
	wg.Wait()

	if hpaErr != nil {
		return nil, fmt.Errorf("get hpa %s/%s: %w", namespace, name, hpaErr)
	}
	result := hparow.Info(hpa)

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
		metricsSpec = append(metricsSpec, hparow.MetricSpec(m))
	}
	result["metrics_spec"] = metricsSpec

	// Current metrics status
	metricsStatus := make([]map[string]interface{}, 0, len(hpa.Status.CurrentMetrics))
	for _, m := range hpa.Status.CurrentMetrics {
		metricsStatus = append(metricsStatus, hparow.MetricStatus(m))
	}
	result["metrics_status"] = metricsStatus

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(hpa.Status.Conditions))
	for _, c := range hpa.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Events
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteHPA deletes an HPA.
func (s *Service) DeleteHPA(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatHPAList(hpas []autoscalingv2.HorizontalPodAutoscaler) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(hpas))
	for i := range hpas {
		result = append(result, hparow.Info(&hpas[i]))
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
