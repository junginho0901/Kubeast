package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	schedulingv1 "k8s.io/api/scheduling/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPriorityClasses lists all PriorityClasses.
func (s *Service) GetPriorityClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.SchedulingV1().PriorityClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list priorityclasses: %w", err)
	}
	return formatPriorityClassList(list.Items), nil
}

// DescribePriorityClass returns detailed info about a PriorityClass.
func (s *Service) DescribePriorityClass(ctx context.Context, name string) (map[string]interface{}, error) {
	var pc *schedulingv1.PriorityClass
	var events *corev1.EventList
	var pcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pc, pcErr = s.clientset.SchedulingV1().PriorityClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PriorityClass", name),
		})
	}()
	wg.Wait()

	if pcErr != nil {
		return nil, fmt.Errorf("get priorityclass %s: %w", name, pcErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatPriorityClassDetail(pc)

	// Additional metadata
	result["uid"] = string(pc.UID)
	result["resource_version"] = pc.ResourceVersion
	result["generation"] = pc.Generation
	result["annotations"] = pc.Annotations
	result["labels"] = pc.Labels

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

// DeletePriorityClass deletes a PriorityClass.
func (s *Service) DeletePriorityClass(ctx context.Context, name string) error {
	return s.clientset.SchedulingV1().PriorityClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPriorityClassList(pcs []schedulingv1.PriorityClass) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pcs))
	for i := range pcs {
		result = append(result, formatPriorityClassDetail(&pcs[i]))
	}
	return result
}

func formatPriorityClassDetail(pc *schedulingv1.PriorityClass) map[string]interface{} {
	globalDefault := false
	if pc.GlobalDefault {
		globalDefault = true
	}

	preemptionPolicy := "PreemptLowerPriority"
	if pc.PreemptionPolicy != nil {
		preemptionPolicy = string(*pc.PreemptionPolicy)
	}

	return map[string]interface{}{
		"name":              pc.Name,
		"value":             pc.Value,
		"global_default":    globalDefault,
		"preemption_policy": preemptionPolicy,
		"description":       pc.Description,
		"labels":            pc.Labels,
		"created_at":        toISO(&pc.CreationTimestamp),
	}
}
