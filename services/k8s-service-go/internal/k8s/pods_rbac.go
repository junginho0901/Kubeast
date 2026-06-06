package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPodRBAC returns RBAC info for a pod's service account.
func (s *Service) GetPodRBAC(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	pod, err := s.clientsetCtx(ctx).CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pod %s/%s: %w", namespace, name, err)
	}

	saName := pod.Spec.ServiceAccountName
	if saName == "" {
		saName = "default"
	}

	sa, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(namespace).Get(ctx, saName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get service account %s: %w", saName, err)
	}

	// Find role bindings
	roleBindings, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list role bindings: %w", err)
	}

	clusterRoleBindings, err := s.clientsetCtx(ctx).RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list cluster role bindings: %w", err)
	}

	bindings := make([]map[string]interface{}, 0)
	for _, rb := range roleBindings.Items {
		for _, subject := range rb.Subjects {
			if subject.Kind == "ServiceAccount" && subject.Name == saName && subject.Namespace == namespace {
				bindings = append(bindings, map[string]interface{}{
					"binding_type": "RoleBinding",
					"binding_name": rb.Name,
					"role_kind":    rb.RoleRef.Kind,
					"role_name":    rb.RoleRef.Name,
				})
			}
		}
	}

	for _, crb := range clusterRoleBindings.Items {
		for _, subject := range crb.Subjects {
			if subject.Kind == "ServiceAccount" && subject.Name == saName && (subject.Namespace == namespace || subject.Namespace == "") {
				bindings = append(bindings, map[string]interface{}{
					"binding_type": "ClusterRoleBinding",
					"binding_name": crb.Name,
					"role_kind":    crb.RoleRef.Kind,
					"role_name":    crb.RoleRef.Name,
				})
			}
		}
	}

	secrets := make([]string, 0, len(sa.Secrets))
	for _, s := range sa.Secrets {
		secrets = append(secrets, s.Name)
	}

	return map[string]interface{}{
		"pod_name":               name,
		"namespace":              namespace,
		"service_account_name":   saName,
		"service_account_labels": sa.Labels,
		"secrets":                secrets,
		"bindings":               bindings,
	}, nil
}
