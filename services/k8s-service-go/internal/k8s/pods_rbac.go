package k8s

import (
	"context"
	"fmt"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	groupServiceAccounts = "system:serviceaccounts"
	groupAuthenticated   = "system:authenticated"
)

// podRBACIdentity is who a pod's ServiceAccount is to the API server. Every authenticated subject is also in
// system:authenticated, which is only looked at when asked for: its bindings say little about this pod.
type podRBACIdentity struct {
	namespace            string
	serviceAccount       string
	includeAuthenticated bool
}

// match says why a binding's subject applies to the identity, by the API server's rule (appliesToUser): a ServiceAccount
// subject without a namespace is one of the RoleBinding's namespace and of none in a ClusterRoleBinding, which has "".
func (i podRBACIdentity) match(subject rbacv1.Subject, bindingNamespace string) (reason string, broad bool) {
	switch subject.Kind {
	case rbacv1.ServiceAccountKind:
		namespace := subject.Namespace
		if namespace == "" {
			namespace = bindingNamespace
		}
		if subject.Name == i.serviceAccount && namespace == i.namespace {
			return "serviceaccount", false
		}
	case rbacv1.UserKind:
		if subject.Name == "system:serviceaccount:"+i.namespace+":"+i.serviceAccount {
			return "user:system:serviceaccount", false
		}
	case rbacv1.GroupKind:
		switch subject.Name {
		case groupServiceAccounts:
			return "group:serviceaccounts", false
		case groupServiceAccounts + ":" + i.namespace:
			return "group:serviceaccounts:namespace", false
		case groupAuthenticated:
			if i.includeAuthenticated {
				return "group:system:authenticated", true
			}
		}
	}
	return "", false
}

// podRBACRead reads as the caller and keeps what the cluster refused, each thing named once.
type podRBACRead struct {
	ctx      context.Context
	client   kubernetes.Interface
	identity podRBACIdentity
	roles    map[string]map[string]interface{}
	errors   []string
}

func (r *podRBACRead) role(ref rbacv1.RoleRef, namespace string) map[string]interface{} {
	isClusterRole := ref.Kind == "ClusterRole"
	key := "cluster/" + ref.Name
	if !isClusterRole {
		key = namespace + "/" + ref.Name
	}
	if read, ok := r.roles[key]; ok {
		return read
	}
	var rules []rbacv1.PolicyRule
	var err error
	label := "role"
	if isClusterRole {
		label = "cluster role"
		var cr *rbacv1.ClusterRole
		if cr, err = r.client.RbacV1().ClusterRoles().Get(r.ctx, ref.Name, metav1.GetOptions{}); err == nil {
			rules = cr.Rules
		}
	} else {
		var role *rbacv1.Role
		if role, err = r.client.RbacV1().Roles(namespace).Get(r.ctx, ref.Name, metav1.GetOptions{}); err == nil {
			rules = role.Rules
		}
	}
	read := map[string]interface{}{"api_group": ref.APIGroup, "kind": ref.Kind, "name": ref.Name, "rules": podRBACRules(rules)}
	if err != nil {
		read["error"] = err.Error()
		r.errors = append(r.errors, fmt.Sprintf("get %s %s: %v", label, ref.Name, err))
	}
	r.roles[key] = read
	return read
}

func podRBACRules(rules []rbacv1.PolicyRule) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(rules))
	orEmpty := func(values []string) []string {
		if values == nil {
			return []string{}
		}
		return values
	}
	for _, rule := range rules {
		out = append(out, map[string]interface{}{
			"verbs":             orEmpty(rule.Verbs),
			"api_groups":        orEmpty(rule.APIGroups),
			"resources":         orEmpty(rule.Resources),
			"resource_names":    orEmpty(rule.ResourceNames),
			"non_resource_urls": orEmpty(rule.NonResourceURLs),
		})
	}
	return out
}

// binding is the row of a binding that applies to the identity, nil for any other.
func (r *podRBACRead) binding(meta metav1.ObjectMeta, subjects []rbacv1.Subject, ref rbacv1.RoleRef) map[string]interface{} {
	matched := []map[string]interface{}{}
	onlyBroad := true
	rows := make([]map[string]interface{}, 0, len(subjects))
	for _, subject := range subjects {
		row := map[string]interface{}{"kind": subject.Kind, "api_group": subject.APIGroup, "name": subject.Name, "namespace": subject.Namespace}
		rows = append(rows, row)
		if reason, broad := r.identity.match(subject, meta.Namespace); reason != "" {
			matched = append(matched, map[string]interface{}{"reason": reason, "broad": broad, "subject": row})
			onlyBroad = onlyBroad && broad
		}
	}
	if len(matched) == 0 {
		return nil
	}
	out := map[string]interface{}{
		"name":          meta.Name,
		"subjects":      rows,
		"matched_by":    matched,
		"is_broad":      onlyBroad,
		"role_ref":      map[string]interface{}{"api_group": ref.APIGroup, "kind": ref.Kind, "name": ref.Name},
		"resolved_role": r.role(ref, meta.Namespace),
		"created_at":    toISO(&meta.CreationTimestamp),
	}
	if meta.Namespace != "" {
		out["namespace"] = meta.Namespace
	}
	return out
}

// GetPodRBAC answers the Cluster View's RBAC tab and the AI tool pod_rbac: the pod's ServiceAccount, each binding in the
// pod's namespace and the cluster that applies to it, what matched and what its role allows, as
// `kubectl auth can-i --list --as system:serviceaccount:<ns>:<sa> -n <ns>` adds up. Everything is read as the caller:
// what the cluster refuses is named beside what it gave, and a list not read has no key rather than an empty value.
// includeAuthenticated also looks at system:authenticated.
func (s *Service) GetPodRBAC(ctx context.Context, namespace, name string, includeAuthenticated bool) (map[string]interface{}, error) {
	client := s.clientsetCtx(ctx)
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get pod %s/%s: %w", namespace, name, err)
	}

	saName := pod.Spec.ServiceAccountName
	if saName == "" {
		saName = "default"
	}

	read := &podRBACRead{
		ctx:      ctx,
		client:   client,
		identity: podRBACIdentity{namespace: namespace, serviceAccount: saName, includeAuthenticated: includeAuthenticated},
		roles:    map[string]map[string]interface{}{},
		errors:   []string{},
	}
	result := map[string]interface{}{
		"pod_name":              name,
		"namespace":             namespace,
		"service_account_name":  saName,
		"pod":                   map[string]interface{}{"name": name, "namespace": namespace},
		"service_account":       map[string]interface{}{"name": saName, "namespace": namespace},
		"include_authenticated": includeAuthenticated,
	}

	sa, err := client.CoreV1().ServiceAccounts(namespace).Get(ctx, saName, metav1.GetOptions{})
	if err != nil {
		result["service_account_error"] = err.Error()
		read.errors = append(read.errors, fmt.Sprintf("get service account %s: %v", saName, err))
	} else {
		secrets := make([]string, 0, len(sa.Secrets))
		for _, secret := range sa.Secrets {
			secrets = append(secrets, secret.Name)
		}
		result["secrets"] = secrets
		result["service_account_labels"] = sa.Labels
	}

	summary := make([]map[string]interface{}, 0)
	note := func(bindingType string, row map[string]interface{}, ref rbacv1.RoleRef) {
		summary = append(summary, map[string]interface{}{
			"binding_type": bindingType,
			"binding_name": row["name"],
			"role_kind":    ref.Kind,
			"role_name":    ref.Name,
		})
	}

	if roleBindings, err := client.RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{}); err != nil {
		result["role_bindings_error"] = err.Error()
		read.errors = append(read.errors, fmt.Sprintf("list role bindings: %v", err))
	} else {
		rows := make([]map[string]interface{}, 0)
		for i := range roleBindings.Items {
			rb := &roleBindings.Items[i]
			if row := read.binding(rb.ObjectMeta, rb.Subjects, rb.RoleRef); row != nil {
				rows = append(rows, row)
				note("RoleBinding", row, rb.RoleRef)
			}
		}
		result["role_bindings"] = rows
	}

	if clusterRoleBindings, err := client.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{}); err != nil {
		result["cluster_role_bindings_error"] = err.Error()
		read.errors = append(read.errors, fmt.Sprintf("list cluster role bindings: %v", err))
	} else {
		rows := make([]map[string]interface{}, 0)
		for i := range clusterRoleBindings.Items {
			crb := &clusterRoleBindings.Items[i]
			if row := read.binding(crb.ObjectMeta, crb.Subjects, crb.RoleRef); row != nil {
				rows = append(rows, row)
				note("ClusterRoleBinding", row, crb.RoleRef)
			}
		}
		result["cluster_role_bindings"] = rows
	}

	result["bindings"] = summary
	result["errors"] = read.errors
	return result, nil
}
