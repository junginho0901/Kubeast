package k8s

import (
	"context"
	"fmt"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ========== NetworkPolicies ==========

// GetNetworkPolicies lists network policies in a namespace.
func (s *Service) GetNetworkPolicies(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().NetworkingV1().NetworkPolicies(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list network policies: %w", err)
	}
	return formatNetworkPolicyList(list.Items), nil
}

// GetAllNetworkPolicies lists network policies across all namespaces.
func (s *Service) GetAllNetworkPolicies(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().NetworkingV1().NetworkPolicies("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all network policies: %w", err)
	}
	return formatNetworkPolicyList(list.Items), nil
}

// DescribeNetworkPolicy returns detailed info about a network policy.
func (s *Service) DescribeNetworkPolicy(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	np, err := s.Clientset().NetworkingV1().NetworkPolicies(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get network policy %s/%s: %w", namespace, name, err)
	}

	// formatNetworkPolicyDetail already includes all fields
	result := formatNetworkPolicyDetail(np)
	result["finalizers"] = np.Finalizers
	return result, nil
}

// DeleteNetworkPolicy deletes a network policy.
func (s *Service) DeleteNetworkPolicy(ctx context.Context, namespace, name string) error {
	return s.Clientset().NetworkingV1().NetworkPolicies(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatNetworkPolicyList(items []networkingv1.NetworkPolicy) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, np := range items {
		result = append(result, formatNetworkPolicyDetail(&np))
	}
	return result
}

func formatNetworkPolicyDetail(np *networkingv1.NetworkPolicy) map[string]interface{} {
	policyTypes := make([]string, 0, len(np.Spec.PolicyTypes))
	for _, pt := range np.Spec.PolicyTypes {
		policyTypes = append(policyTypes, string(pt))
	}

	podSelector := map[string]interface{}{}
	if np.Spec.PodSelector.MatchLabels != nil {
		podSelector["match_labels"] = np.Spec.PodSelector.MatchLabels
	}
	if len(np.Spec.PodSelector.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0)
		for _, e := range np.Spec.PodSelector.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      e.Key,
				"operator": string(e.Operator),
				"values":   e.Values,
			})
		}
		podSelector["match_expressions"] = exprs
	}

	selectsAllPods := len(np.Spec.PodSelector.MatchLabels) == 0 && len(np.Spec.PodSelector.MatchExpressions) == 0

	// Check default deny
	defaultDenyIngress := false
	defaultDenyEgress := false
	for _, pt := range np.Spec.PolicyTypes {
		if pt == networkingv1.PolicyTypeIngress && len(np.Spec.Ingress) == 0 {
			defaultDenyIngress = true
		}
		if pt == networkingv1.PolicyTypeEgress && len(np.Spec.Egress) == 0 {
			defaultDenyEgress = true
		}
	}

	// Build ingress rules
	ingressRules := make([]map[string]interface{}, 0, len(np.Spec.Ingress))
	for _, rule := range np.Spec.Ingress {
		r := map[string]interface{}{}
		from := make([]map[string]interface{}, 0, len(rule.From))
		for _, f := range rule.From {
			peer := map[string]interface{}{}
			if f.PodSelector != nil {
				peer["pod_selector"] = f.PodSelector.MatchLabels
			}
			if f.NamespaceSelector != nil {
				peer["namespace_selector"] = f.NamespaceSelector.MatchLabels
			}
			if f.IPBlock != nil {
				ipBlock := map[string]interface{}{"cidr": f.IPBlock.CIDR}
				if len(f.IPBlock.Except) > 0 {
					ipBlock["except"] = f.IPBlock.Except
				}
				peer["ip_block"] = ipBlock
			}
			from = append(from, peer)
		}
		r["from"] = from
		ports := make([]map[string]interface{}, 0, len(rule.Ports))
		for _, p := range rule.Ports {
			port := map[string]interface{}{}
			if p.Protocol != nil {
				port["protocol"] = string(*p.Protocol)
			}
			if p.Port != nil {
				port["port"] = p.Port.String()
			}
			ports = append(ports, port)
		}
		r["ports"] = ports
		ingressRules = append(ingressRules, r)
	}

	// Build egress rules
	egressRules := make([]map[string]interface{}, 0, len(np.Spec.Egress))
	for _, rule := range np.Spec.Egress {
		r := map[string]interface{}{}
		to := make([]map[string]interface{}, 0, len(rule.To))
		for _, t := range rule.To {
			peer := map[string]interface{}{}
			if t.PodSelector != nil {
				peer["pod_selector"] = t.PodSelector.MatchLabels
			}
			if t.NamespaceSelector != nil {
				peer["namespace_selector"] = t.NamespaceSelector.MatchLabels
			}
			if t.IPBlock != nil {
				ipBlock := map[string]interface{}{"cidr": t.IPBlock.CIDR}
				if len(t.IPBlock.Except) > 0 {
					ipBlock["except"] = t.IPBlock.Except
				}
				peer["ip_block"] = ipBlock
			}
			to = append(to, peer)
		}
		r["to"] = to
		ports := make([]map[string]interface{}, 0, len(rule.Ports))
		for _, p := range rule.Ports {
			port := map[string]interface{}{}
			if p.Protocol != nil {
				port["protocol"] = string(*p.Protocol)
			}
			if p.Port != nil {
				port["port"] = p.Port.String()
			}
			ports = append(ports, port)
		}
		r["ports"] = ports
		egressRules = append(egressRules, r)
	}

	return map[string]interface{}{
		"name":                 np.Name,
		"namespace":            np.Namespace,
		"pod_selector":         podSelector,
		"selects_all_pods":     selectsAllPods,
		"policy_types":         policyTypes,
		"default_deny_ingress": defaultDenyIngress,
		"default_deny_egress":  defaultDenyEgress,
		"ingress_rules":        len(np.Spec.Ingress),
		"egress_rules":         len(np.Spec.Egress),
		"ingress":              ingressRules,
		"egress":               egressRules,
		"labels":               np.Labels,
		"annotations":          np.Annotations,
		"created_at":           toISO(&np.CreationTimestamp),
	}
}
