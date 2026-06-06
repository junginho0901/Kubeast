package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
	list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all serviceaccounts: %w", err)
	}
	return formatServiceAccountList(list.Items), nil
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
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteServiceAccount deletes a serviceaccount.
func (s *Service) DeleteServiceAccount(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).CoreV1().ServiceAccounts(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatServiceAccountList(items []corev1.ServiceAccount) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, sa := range items {
		secretsList := make([]string, 0, len(sa.Secrets))
		for _, s := range sa.Secrets {
			if s.Name != "" {
				secretsList = append(secretsList, s.Name)
			}
		}
		imagePullSecrets := make([]string, 0, len(sa.ImagePullSecrets))
		for _, ips := range sa.ImagePullSecrets {
			if ips.Name != "" {
				imagePullSecrets = append(imagePullSecrets, ips.Name)
			}
		}
		result = append(result, map[string]interface{}{
			"name":               sa.Name,
			"namespace":          sa.Namespace,
			"secrets":            len(sa.Secrets),
			"secrets_list":       secretsList,
			"image_pull_secrets": imagePullSecrets,
			"created_at":         toISO(&sa.CreationTimestamp),
			"labels":             sa.Labels,
			"annotations":        sa.Annotations,
		})
	}
	return result
}

func formatServiceAccountDetail(sa *corev1.ServiceAccount) map[string]interface{} {
	result := map[string]interface{}{
		"name":             sa.Name,
		"namespace":        sa.Namespace,
		"secrets":          len(sa.Secrets),
		"created_at":       toISO(&sa.CreationTimestamp),
		"labels":           sa.Labels,
		"annotations":      sa.Annotations,
		"uid":              string(sa.UID),
		"resource_version": sa.ResourceVersion,
	}

	if sa.AutomountServiceAccountToken != nil {
		result["automount_service_account_token"] = *sa.AutomountServiceAccountToken
	}

	// Image pull secrets
	imagePullSecrets := make([]string, 0, len(sa.ImagePullSecrets))
	for _, ips := range sa.ImagePullSecrets {
		imagePullSecrets = append(imagePullSecrets, ips.Name)
	}
	result["image_pull_secrets"] = imagePullSecrets

	// Secrets list
	secrets := make([]string, 0, len(sa.Secrets))
	for _, s := range sa.Secrets {
		secrets = append(secrets, s.Name)
	}
	result["secrets_list"] = secrets

	return result
}
