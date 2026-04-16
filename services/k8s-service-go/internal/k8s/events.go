package k8s

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetEvents lists events in a namespace, optionally filtered by resource name.
func (s *Service) GetEvents(ctx context.Context, namespace string, resourceName string) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{}
	if resourceName != "" {
		opts.FieldSelector = fmt.Sprintf("involvedObject.name=%s", resourceName)
	}

	var eventList *corev1.EventList
	var err error

	if namespace != "" {
		eventList, err = s.Clientset().CoreV1().Events(namespace).List(ctx, opts)
	} else {
		eventList, err = s.Clientset().CoreV1().Events("").List(ctx, opts)
	}
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}

	sortEventsByTime(eventList.Items)

	result := make([]map[string]interface{}, 0, len(eventList.Items))
	for _, e := range eventList.Items {
		result = append(result, map[string]interface{}{
			"name":                e.Name,
			"namespace":           e.Namespace,
			"type":                e.Type,
			"reason":              e.Reason,
			"message":             e.Message,
			"count":               e.Count,
			"first_timestamp":     toISO(&e.FirstTimestamp),
			"last_timestamp":      toISO(&e.LastTimestamp),
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
		})
	}
	return result, nil
}
