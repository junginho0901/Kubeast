package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetResourceQuotas lists ResourceQuotas in a namespace.
func (s *Service) GetResourceQuotas(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().ResourceQuotas(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resource quotas: %w", err)
	}
	return formatResourceQuotaList(list.Items), nil
}

// GetAllResourceQuotas lists ResourceQuotas across all namespaces.
func (s *Service) GetAllResourceQuotas(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().ResourceQuotas("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all resource quotas: %w", err)
	}
	return formatResourceQuotaList(list.Items), nil
}

// DescribeResourceQuota returns detailed info about a ResourceQuota.
func (s *Service) DescribeResourceQuota(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var rq *corev1.ResourceQuota
	var events *corev1.EventList
	var rqErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		rq, rqErr = s.Clientset().CoreV1().ResourceQuotas(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ResourceQuota", name),
		})
	}()
	wg.Wait()

	if rqErr != nil {
		return nil, fmt.Errorf("get resource quota %s/%s: %w", namespace, name, rqErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatResourceQuotaDetail(rq)

	result["uid"] = string(rq.UID)
	result["resource_version"] = rq.ResourceVersion
	result["annotations"] = rq.Annotations
	result["labels"] = rq.Labels

	// Spec hard (desired)
	specHard := make(map[string]string)
	for k, v := range rq.Spec.Hard {
		specHard[string(k)] = v.String()
	}
	result["spec_hard"] = specHard

	// Spec scopes
	scopes := make([]string, 0, len(rq.Spec.Scopes))
	for _, s := range rq.Spec.Scopes {
		scopes = append(scopes, string(s))
	}
	result["scopes"] = scopes

	// Scope selector
	if rq.Spec.ScopeSelector != nil {
		selectors := make([]map[string]interface{}, 0)
		for _, me := range rq.Spec.ScopeSelector.MatchExpressions {
			vals := make([]string, len(me.Values))
			copy(vals, me.Values)
			selectors = append(selectors, map[string]interface{}{
				"scope_name": string(me.ScopeName),
				"operator":   string(me.Operator),
				"values":     vals,
			})
		}
		result["scope_selector"] = selectors
	}

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

// DeleteResourceQuota deletes a ResourceQuota.
func (s *Service) DeleteResourceQuota(ctx context.Context, namespace, name string) error {
	return s.Clientset().CoreV1().ResourceQuotas(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatResourceQuotaList(items []corev1.ResourceQuota) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, formatResourceQuotaDetail(&items[i]))
	}
	return result
}

func formatResourceQuotaDetail(rq *corev1.ResourceQuota) map[string]interface{} {
	hard := make(map[string]string)
	used := make(map[string]string)
	for k, v := range rq.Status.Hard {
		hard[string(k)] = v.String()
	}
	for k, v := range rq.Status.Used {
		used[string(k)] = v.String()
	}
	return map[string]interface{}{
		"name":        rq.Name,
		"namespace":   rq.Namespace,
		"labels":      rq.Labels,
		"status_hard": hard,
		"status_used": used,
		"created_at":  toISO(&rq.CreationTimestamp),
	}
}
