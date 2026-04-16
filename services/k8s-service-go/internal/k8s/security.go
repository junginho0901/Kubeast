package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== ServiceAccounts ==========

// GetServiceAccounts lists serviceaccounts in a namespace.
func (s *Service) GetServiceAccounts(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().ServiceAccounts(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list serviceaccounts: %w", err)
	}
	return formatServiceAccountList(list.Items), nil
}

// GetAllServiceAccounts lists serviceaccounts across all namespaces.
func (s *Service) GetAllServiceAccounts(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().CoreV1().ServiceAccounts("").List(ctx, metav1.ListOptions{})
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
		sa, saErr = s.Clientset().CoreV1().ServiceAccounts(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
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
	return s.Clientset().CoreV1().ServiceAccounts(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Roles ==========

// GetRoles lists roles in a namespace.
func (s *Service) GetRoles(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().RbacV1().Roles(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	return formatRoleList(list.Items), nil
}

// GetAllRoles lists roles across all namespaces.
func (s *Service) GetAllRoles(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().RbacV1().Roles("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all roles: %w", err)
	}
	return formatRoleList(list.Items), nil
}

// DescribeRole returns detailed info about a role.
func (s *Service) DescribeRole(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var role *rbacv1.Role
	var events *corev1.EventList
	var roleErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		role, roleErr = s.Clientset().RbacV1().Roles(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Role", name),
		})
	}()
	wg.Wait()

	if roleErr != nil {
		return nil, fmt.Errorf("get role %s/%s: %w", namespace, name, roleErr)
	}

	result := formatRoleDetail(role)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteRole deletes a role.
func (s *Service) DeleteRole(ctx context.Context, namespace, name string) error {
	return s.Clientset().RbacV1().Roles(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== RoleBindings ==========

// GetRoleBindings lists rolebindings in a namespace.
func (s *Service) GetRoleBindings(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list rolebindings: %w", err)
	}
	return formatRoleBindingList(list.Items), nil
}

// GetAllRoleBindings lists rolebindings across all namespaces.
func (s *Service) GetAllRoleBindings(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().RbacV1().RoleBindings("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all rolebindings: %w", err)
	}
	return formatRoleBindingList(list.Items), nil
}

// DescribeRoleBinding returns detailed info about a rolebinding.
func (s *Service) DescribeRoleBinding(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var wg sync.WaitGroup
	var rb *rbacv1.RoleBinding
	var events *corev1.EventList
	var rbErr, eventsErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		rb, rbErr = s.Clientset().RbacV1().RoleBindings(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=RoleBinding", name),
		})
	}()
	wg.Wait()

	if rbErr != nil {
		return nil, fmt.Errorf("get rolebinding %s/%s: %w", namespace, name, rbErr)
	}

	result := formatRoleBindingDetail(rb)

	// Events
	if eventsErr == nil {
		sortEventsByTime(events.Items)
		result["events"] = formatEventList(events.Items)
	}

	return result, nil
}

// DeleteRoleBinding deletes a rolebinding.
func (s *Service) DeleteRoleBinding(ctx context.Context, namespace, name string) error {
	return s.Clientset().RbacV1().RoleBindings(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ========== Format Functions ==========

func formatServiceAccountList(items []corev1.ServiceAccount) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, sa := range items {
		result = append(result, map[string]interface{}{
			"name":        sa.Name,
			"namespace":   sa.Namespace,
			"secrets":     len(sa.Secrets),
			"created_at":  toISO(&sa.CreationTimestamp),
			"labels":      sa.Labels,
			"annotations": sa.Annotations,
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

func formatRoleList(items []rbacv1.Role) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, role := range items {
		result = append(result, map[string]interface{}{
			"name":        role.Name,
			"namespace":   role.Namespace,
			"rules_count": len(role.Rules),
			"created_at":  toISO(&role.CreationTimestamp),
			"labels":      role.Labels,
			"annotations": role.Annotations,
		})
	}
	return result
}

func formatRoleDetail(role *rbacv1.Role) map[string]interface{} {
	// Format rules
	rules := make([]map[string]interface{}, 0, len(role.Rules))
	for _, r := range role.Rules {
		rules = append(rules, map[string]interface{}{
			"apiGroups":     r.APIGroups,
			"resources":     r.Resources,
			"verbs":         r.Verbs,
			"resourceNames": r.ResourceNames,
		})
	}

	return map[string]interface{}{
		"name":             role.Name,
		"namespace":        role.Namespace,
		"rules_count":      len(role.Rules),
		"created_at":       toISO(&role.CreationTimestamp),
		"labels":           role.Labels,
		"annotations":      role.Annotations,
		"uid":              string(role.UID),
		"resource_version": role.ResourceVersion,
		"rules":            rules,
	}
}

func formatRoleBindingList(items []rbacv1.RoleBinding) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, rb := range items {
		result = append(result, map[string]interface{}{
			"name":           rb.Name,
			"namespace":      rb.Namespace,
			"role_ref_kind":  rb.RoleRef.Kind,
			"role_ref_name":  rb.RoleRef.Name,
			"subjects_count": len(rb.Subjects),
			"created_at":     toISO(&rb.CreationTimestamp),
			"labels":         rb.Labels,
			"annotations":    rb.Annotations,
		})
	}
	return result
}

func formatRoleBindingDetail(rb *rbacv1.RoleBinding) map[string]interface{} {
	// Format subjects
	subjects := make([]map[string]interface{}, 0, len(rb.Subjects))
	for _, s := range rb.Subjects {
		subjects = append(subjects, map[string]interface{}{
			"kind":      s.Kind,
			"name":      s.Name,
			"namespace": s.Namespace,
			"apiGroup":  s.APIGroup,
		})
	}

	return map[string]interface{}{
		"name":               rb.Name,
		"namespace":          rb.Namespace,
		"role_ref_kind":      rb.RoleRef.Kind,
		"role_ref_name":      rb.RoleRef.Name,
		"role_ref_api_group": rb.RoleRef.APIGroup,
		"subjects_count":     len(rb.Subjects),
		"subjects":           subjects,
		"created_at":         toISO(&rb.CreationTimestamp),
		"labels":             rb.Labels,
		"annotations":        rb.Annotations,
		"uid":                string(rb.UID),
		"resource_version":   rb.ResourceVersion,
	}
}
