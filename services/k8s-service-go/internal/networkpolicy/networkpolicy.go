// Package networkpolicy is a NetworkPolicy as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package networkpolicy

import (
	"time"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Info is the policy's row: its pod selector, types, default denies and rules, with each rule's peers and ports whole
// because the drawer opened from a row words them.
func Info(np *networkingv1.NetworkPolicy) map[string]interface{} {
	policyTypes := make([]string, 0, len(np.Spec.PolicyTypes))
	for _, pt := range np.Spec.PolicyTypes {
		policyTypes = append(policyTypes, string(pt))
	}

	selectsAllPods := len(np.Spec.PodSelector.MatchLabels) == 0 && len(np.Spec.PodSelector.MatchExpressions) == 0

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

	ingressRules := make([]map[string]interface{}, 0, len(np.Spec.Ingress))
	for _, rule := range np.Spec.Ingress {
		ingressRules = append(ingressRules, map[string]interface{}{"from": peers(rule.From), "ports": ports(rule.Ports)})
	}

	egressRules := make([]map[string]interface{}, 0, len(np.Spec.Egress))
	for _, rule := range np.Spec.Egress {
		egressRules = append(egressRules, map[string]interface{}{"to": peers(rule.To), "ports": ports(rule.Ports)})
	}

	created := ""
	if !np.CreationTimestamp.IsZero() {
		created = np.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":                 np.Name,
		"namespace":            np.Namespace,
		"pod_selector":         selector(np.Spec.PodSelector),
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
		"finalizers":           np.Finalizers,
		"created_at":           created,
	}
}

// selector is written the same at the policy's top and in a peer. It is a map even with no terms: an empty selector
// selects everything, which is not the same as a peer without that selector.
func selector(s metav1.LabelSelector) map[string]interface{} {
	out := map[string]interface{}{}
	if s.MatchLabels != nil {
		out["match_labels"] = s.MatchLabels
	}
	if len(s.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0, len(s.MatchExpressions))
		for _, e := range s.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      e.Key,
				"operator": string(e.Operator),
				"values":   e.Values,
			})
		}
		out["match_expressions"] = exprs
	}
	return out
}

func peers(list []networkingv1.NetworkPolicyPeer) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(list))
	for _, p := range list {
		peer := map[string]interface{}{}
		if p.PodSelector != nil {
			peer["pod_selector"] = selector(*p.PodSelector)
		}
		if p.NamespaceSelector != nil {
			peer["namespace_selector"] = selector(*p.NamespaceSelector)
		}
		if p.IPBlock != nil {
			ipBlock := map[string]interface{}{"cidr": p.IPBlock.CIDR}
			if len(p.IPBlock.Except) > 0 {
				ipBlock["except"] = p.IPBlock.Except
			}
			peer["ip_block"] = ipBlock
		}
		out = append(out, peer)
	}
	return out
}

func ports(list []networkingv1.NetworkPolicyPort) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(list))
	for _, p := range list {
		port := map[string]interface{}{}
		if p.Protocol != nil {
			port["protocol"] = string(*p.Protocol)
		}
		if p.Port != nil {
			port["port"] = p.Port.String()
		}
		if p.EndPort != nil {
			port["end_port"] = *p.EndPort
		}
		out = append(out, port)
	}
	return out
}
