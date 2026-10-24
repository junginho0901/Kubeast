package netpol

import (
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Effective is what applies to pods with given labels in a namespace, per direction.
type Effective struct {
	Ingress Direction `json:"ingress"`
	Egress  Direction `json:"egress"`
}

// Direction lists the policies that select the pods for one direction. When
// none does, the direction is not isolated and every connection is allowed.
type Direction struct {
	Isolated bool          `json:"isolated"`
	Policies []PolicyRules `json:"policies"`
}

// PolicyRules is one policy's rules for a direction; no rules means it only isolates.
type PolicyRules struct {
	Name  string        `json:"name"`
	Rules []RuleSummary `json:"rules"`
}

// RuleSummary is one rule: no peers means every source or destination, no
// ports every port.
type RuleSummary struct {
	Peers []PeerSummary `json:"peers"`
	Ports []PortSummary `json:"ports"`
}

// PeerSummary is one peer. A selector is in label-selector syntax; an empty
// string selects everything, an absent one is not part of the peer.
type PeerSummary struct {
	PodSelector       *string  `json:"pod_selector,omitempty"`
	NamespaceSelector *string  `json:"namespace_selector,omitempty"`
	CIDR              string   `json:"cidr,omitempty"`
	Except            []string `json:"except,omitempty"`
}

// PortSummary is one port entry; an empty Port is every port of the protocol.
type PortSummary struct {
	Protocol string `json:"protocol"`
	Port     string `json:"port,omitempty"`
	EndPort  int32  `json:"end_port,omitempty"`
}

// Summarize lists the policies of namespace that select pods with podLabels.
func Summarize(policies []networkingv1.NetworkPolicy, namespace string, podLabels map[string]string) Effective {
	e := Effective{Ingress: Direction{Policies: []PolicyRules{}}, Egress: Direction{Policies: []PolicyRules{}}}
	for _, np := range byName(policies) {
		if np.Namespace != namespace || !selects(&np.Spec.PodSelector, podLabels) {
			continue
		}
		for _, dir := range []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress} {
			if !Affects(&np, dir) {
				continue
			}
			d := &e.Ingress
			if dir == networkingv1.PolicyTypeEgress {
				d = &e.Egress
			}
			d.Isolated = true
			pr := PolicyRules{Name: np.Name, Rules: []RuleSummary{}}
			for r := 0; r < ruleCount(&np, dir); r++ {
				peers, ports := rule(&np, dir, r)
				pr.Rules = append(pr.Rules, RuleSummary{Peers: summarizePeers(peers), Ports: summarizePorts(ports)})
			}
			d.Policies = append(d.Policies, pr)
		}
	}
	return e
}

func summarizePeers(peers []networkingv1.NetworkPolicyPeer) []PeerSummary {
	out := make([]PeerSummary, 0, len(peers))
	for _, p := range peers {
		var s PeerSummary
		if p.IPBlock != nil {
			s.CIDR = p.IPBlock.CIDR
			s.Except = p.IPBlock.Except
		}
		s.PodSelector = selectorText(p.PodSelector)
		s.NamespaceSelector = selectorText(p.NamespaceSelector)
		out = append(out, s)
	}
	return out
}

func summarizePorts(ports []networkingv1.NetworkPolicyPort) []PortSummary {
	out := make([]PortSummary, 0, len(ports))
	for _, p := range ports {
		s := PortSummary{Protocol: "TCP"}
		if p.Protocol != nil {
			s.Protocol = string(*p.Protocol)
		}
		if p.Port != nil {
			s.Port = p.Port.String()
		}
		if p.EndPort != nil {
			s.EndPort = *p.EndPort
		}
		out = append(out, s)
	}
	return out
}

// SelectorText is the label-selector syntax of sel ("" selects everything).
func SelectorText(sel *metav1.LabelSelector) string {
	s, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return "(invalid selector)"
	}
	return s.String()
}

func selectorText(sel *metav1.LabelSelector) *string {
	if sel == nil {
		return nil
	}
	t := SelectorText(sel)
	return &t
}
