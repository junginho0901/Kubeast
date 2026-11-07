package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	sarow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/serviceaccount"
)

// GetServiceAccounts lists serviceaccounts in a namespace.
func (s *Service) GetServiceAccounts(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list serviceaccounts: %w", err)
	}
	return formatServiceAccountList(list.Items), nil
}

// GetAllServiceAccounts lists serviceaccounts across all namespaces.
func (s *Service) GetAllServiceAccounts(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all serviceaccounts: %w", err)
		}
		return formatServiceAccountList(list.Items), nil
	})
}

// DescribeServiceAccount returns detailed info about a serviceaccount.
func (s *Service) DescribeServiceAccount(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var sa *corev1.ServiceAccount
	var events *corev1.EventList
	var saErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		sa, saErr = s.clientsetCtx(ctx).CoreV1().ServiceAccounts(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=ServiceAccount", name),
		})
	}()
	wg.Wait()

	if saErr != nil {
		return nil, fmt.Errorf("get serviceaccount %s/%s: %w", namespace, name, saErr)
	}

	result := formatServiceAccountDetail(sa)

	// Events
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeleteServiceAccount deletes a serviceaccount.
func (s *Service) DeleteServiceAccount(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).CoreV1().ServiceAccounts(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatServiceAccountList(items []corev1.ServiceAccount) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, sarow.Info(&items[i]))
	}
	return result
}

func formatServiceAccountDetail(sa *corev1.ServiceAccount) map[string]interface{} {
	result := sarow.Info(sa)
	result["uid"] = string(sa.UID)
	result["resource_version"] = sa.ResourceVersion

	if sa.AutomountServiceAccountToken != nil {
		result["automount_service_account_token"] = *sa.AutomountServiceAccountToken
	}

	return result
}
