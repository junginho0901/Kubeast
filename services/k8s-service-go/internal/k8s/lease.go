package k8s

import (
	"context"
	"fmt"
	"sync"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetLeases lists Leases in a namespace.
func (s *Service) GetLeases(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoordinationV1().Leases(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list leases: %w", err)
	}
	return formatLeaseList(list.Items), nil
}

// GetAllLeases lists Leases across all namespaces.
func (s *Service) GetAllLeases(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoordinationV1().Leases("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all leases: %w", err)
	}
	return formatLeaseList(list.Items), nil
}

// DescribeLease returns detailed info about a Lease.
func (s *Service) DescribeLease(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var lease *coordinationv1.Lease
	var events *corev1.EventList
	var leaseErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		lease, leaseErr = s.Clientset().CoordinationV1().Leases(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Lease", name),
		})
	}()
	wg.Wait()

	if leaseErr != nil {
		return nil, fmt.Errorf("get lease %s/%s: %w", namespace, name, leaseErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatLeaseDetail(lease)

	// Additional metadata
	result["uid"] = string(lease.UID)
	result["resource_version"] = lease.ResourceVersion
	result["generation"] = lease.Generation
	result["annotations"] = lease.Annotations
	result["labels"] = lease.Labels

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

// DeleteLease deletes a Lease.
func (s *Service) DeleteLease(ctx context.Context, namespace, name string) error {
	return s.Clientset().CoordinationV1().Leases(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatLeaseList(leases []coordinationv1.Lease) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(leases))
	for i := range leases {
		result = append(result, formatLeaseDetail(&leases[i]))
	}
	return result
}

func formatLeaseDetail(lease *coordinationv1.Lease) map[string]interface{} {
	result := map[string]interface{}{
		"name":       lease.Name,
		"namespace":  lease.Namespace,
		"labels":     lease.Labels,
		"created_at": toISO(&lease.CreationTimestamp),
	}

	if lease.Spec.HolderIdentity != nil {
		result["holder_identity"] = *lease.Spec.HolderIdentity
	}
	if lease.Spec.LeaseDurationSeconds != nil {
		result["lease_duration_seconds"] = *lease.Spec.LeaseDurationSeconds
	}
	if lease.Spec.LeaseTransitions != nil {
		result["lease_transitions"] = *lease.Spec.LeaseTransitions
	}
	if lease.Spec.RenewTime != nil {
		result["renew_time"] = lease.Spec.RenewTime.Time.Format("2006-01-02T15:04:05Z")
	}
	if lease.Spec.AcquireTime != nil {
		result["acquire_time"] = lease.Spec.AcquireTime.Time.Format("2006-01-02T15:04:05Z")
	}

	return result
}
