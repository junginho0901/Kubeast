package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	nodev1 "k8s.io/api/node/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetRuntimeClasses lists all RuntimeClasses.
func (s *Service) GetRuntimeClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientset.NodeV1().RuntimeClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list runtimeclasses: %w", err)
	}
	return formatRuntimeClassList(list.Items), nil
}

// DescribeRuntimeClass returns detailed info about a RuntimeClass.
func (s *Service) DescribeRuntimeClass(ctx context.Context, name string) (map[string]interface{}, error) {
	var rc *nodev1.RuntimeClass
	var events *corev1.EventList
	var rcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		rc, rcErr = s.clientset.NodeV1().RuntimeClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=RuntimeClass", name),
		})
	}()
	wg.Wait()

	if rcErr != nil {
		return nil, fmt.Errorf("get runtimeclass %s: %w", name, rcErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatRuntimeClassDetail(rc)

	// Additional metadata
	result["uid"] = string(rc.UID)
	result["resource_version"] = rc.ResourceVersion
	result["generation"] = rc.Generation
	result["annotations"] = rc.Annotations
	result["labels"] = rc.Labels

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

// DeleteRuntimeClass deletes a RuntimeClass.
func (s *Service) DeleteRuntimeClass(ctx context.Context, name string) error {
	return s.clientset.NodeV1().RuntimeClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatRuntimeClassList(rcs []nodev1.RuntimeClass) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(rcs))
	for i := range rcs {
		result = append(result, formatRuntimeClassDetail(&rcs[i]))
	}
	return result
}

func formatRuntimeClassDetail(rc *nodev1.RuntimeClass) map[string]interface{} {
	result := map[string]interface{}{
		"name":       rc.Name,
		"handler":    rc.Handler,
		"labels":     rc.Labels,
		"created_at": toISO(&rc.CreationTimestamp),
	}

	// Overhead
	if rc.Overhead != nil {
		overhead := map[string]string{}
		for k, v := range rc.Overhead.PodFixed {
			overhead[string(k)] = v.String()
		}
		result["overhead"] = overhead
	}

	// Scheduling
	if rc.Scheduling != nil {
		scheduling := map[string]interface{}{}
		if rc.Scheduling.NodeSelector != nil {
			scheduling["node_selector"] = rc.Scheduling.NodeSelector
		}
		if len(rc.Scheduling.Tolerations) > 0 {
			tolerations := make([]map[string]interface{}, 0, len(rc.Scheduling.Tolerations))
			for _, t := range rc.Scheduling.Tolerations {
				tol := map[string]interface{}{
					"key":      t.Key,
					"operator": string(t.Operator),
					"effect":   string(t.Effect),
				}
				if t.Value != "" {
					tol["value"] = t.Value
				}
				if t.TolerationSeconds != nil {
					tol["toleration_seconds"] = *t.TolerationSeconds
				}
				tolerations = append(tolerations, tol)
			}
			scheduling["tolerations"] = tolerations
		}
		result["scheduling"] = scheduling
	}

	return result
}
