package k8s

import (
	"context"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetEvents lists the newest limit events in a namespace ("" for all), optionally filtered by resource name and an
// events field selector (the API server checks it), and how many there are. The events are read a page at a time
// (eachEvent), never as one list.
func (s *Service) GetEvents(ctx context.Context, namespace, resourceName, fieldSelector string, limit int) ([]map[string]interface{}, int, error) {
	var selectors []string
	if resourceName != "" {
		selectors = append(selectors, fmt.Sprintf("involvedObject.name=%s", resourceName))
	}
	if fieldSelector != "" {
		selectors = append(selectors, fieldSelector)
	}
	opts := metav1.ListOptions{FieldSelector: strings.Join(selectors, ",")}
	items, counts, err := s.newestEventsSince(ctx, namespace, opts, time.Time{}, limit)
	if err != nil {
		return nil, 0, fmt.Errorf("list events: %w", err)
	}
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, eventRow(&items[i]))
	}
	return result, counts.Total, nil
}

// eventRow is an event as the events API and the issues read it.
func eventRow(e *corev1.Event) map[string]interface{} {
	// events.k8s.io/v1 writers (the scheduler among them) fill eventTime and
	// series instead of lastTimestamp and count.
	last := metav1.NewTime(eventTimestamp(*e))
	count := e.Count
	if e.Series != nil {
		if !e.Series.LastObservedTime.IsZero() {
			last = metav1.NewTime(e.Series.LastObservedTime.Time)
		}
		if count == 0 {
			count = e.Series.Count
		}
	}
	return map[string]interface{}{
		"name":                e.Name,
		"namespace":           e.Namespace,
		"type":                e.Type,
		"reason":              e.Reason,
		"message":             e.Message,
		"count":               count,
		"first_timestamp":     toISO(&e.FirstTimestamp),
		"last_timestamp":      toISO(&last),
		"reporting_component": e.ReportingController,
		"involved_object": map[string]interface{}{
			"kind":      e.InvolvedObject.Kind,
			"name":      e.InvolvedObject.Name,
			"namespace": e.InvolvedObject.Namespace,
		},
		"source": map[string]interface{}{
			"component": e.Source.Component,
			"host":      e.Source.Host,
		},
		"created_at": toISO(&e.CreationTimestamp),
	}
}
