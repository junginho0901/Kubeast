package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetLimitRanges lists LimitRanges in a namespace.
func (s *Service) GetLimitRanges(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().LimitRanges(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list limit ranges: %w", err)
	}
	return formatLimitRangeList(list.Items), nil
}

// GetAllLimitRanges lists LimitRanges across all namespaces.
func (s *Service) GetAllLimitRanges(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().LimitRanges("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all limit ranges: %w", err)
	}
	return formatLimitRangeList(list.Items), nil
}

// DescribeLimitRange returns detailed info about a LimitRange.
func (s *Service) DescribeLimitRange(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var lr *corev1.LimitRange
	var events *corev1.EventList
	var lrErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		lr, lrErr = s.Clientset().CoreV1().LimitRanges(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=LimitRange", name),
		})
	}()
	wg.Wait()

	if lrErr != nil {
		return nil, fmt.Errorf("get limit range %s/%s: %w", namespace, name, lrErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatLimitRangeDetail(lr)

	result["uid"] = string(lr.UID)
	result["resource_version"] = lr.ResourceVersion
	result["annotations"] = lr.Annotations
	result["labels"] = lr.Labels

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

// DeleteLimitRange deletes a LimitRange.
func (s *Service) DeleteLimitRange(ctx context.Context, namespace, name string) error {
	return s.Clientset().CoreV1().LimitRanges(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatLimitRangeList(items []corev1.LimitRange) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, formatLimitRangeDetail(&items[i]))
	}
	return result
}

func formatLimitRangeDetail(lr *corev1.LimitRange) map[string]interface{} {
	return map[string]interface{}{
		"name":       lr.Name,
		"namespace":  lr.Namespace,
		"labels":     lr.Labels,
		"limits":     buildLimitItems(lr.Spec.Limits),
		"created_at": toISO(&lr.CreationTimestamp),
	}
}
