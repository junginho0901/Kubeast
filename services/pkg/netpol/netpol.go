// Package netpol decides whether Kubernetes NetworkPolicy allows a connection
// between two endpoints, and summarises the policies that apply to a pod. It
// follows the NetworkPolicy rules of the Kubernetes documentation and reads
// nothing from a cluster: the caller passes the policies and the endpoints.
//
// Where the documentation leaves the behaviour to the network plugin (an
// ipBlock that covers a pod's IP, hostNetwork pods), the answer is Unknown and
// says why, instead of guessing one plugin's behaviour.
package netpol

import (
	"net/netip"
	"sort"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// NamespaceNameLabel is set by the control plane on every namespace.
const NamespaceNameLabel = "kubernetes.io/metadata.name"

// Endpoint is one end of a connection: pods that share labels and ports (one
// pod, or the pods of one workload), or an address outside the pod network.
type Endpoint struct {
	Namespace string
	// NamespaceLabels are the namespace's labels. Nil means they could not be
	// read; then only kubernetes.io/metadata.name is known.
	NamespaceLabels map[string]string
	// Pod is the pod's name when the endpoint is one pod.
	Pod         string
	Labels      map[string]string
	Ports       []corev1.ContainerPort
	IPs         []netip.Addr
	HostNetwork bool
	// External marks an address, not pods: only IPs is used.
	External bool
}

// Results of a check and of each direction.
const (
	Allowed = "allowed"
	Denied  = "denied"
	Unknown = "unknown"
)

// Why a rule did not allow the connection.
const (
	MissNoRules   = "no_rules"   // the policy has no rules in this direction: it only isolates
	MissPeer      = "peer"       // the other end is not one of the rule's peers
	MissPort      = "port"       // the port or protocol is not one of the rule's ports
	MissNamedPort = "named_port" // the rule names a port the destination does not declare
)

// Why a rule may or may not allow the connection.
const (
	// PodIPBlock: only an ipBlock that covers the pod's IP selects it. Whether
	// ipBlock applies to pod IPs is left to the network plugin.
	PodIPBlock = "pod_ip_block"
	// NamespaceUnknown: the namespace's labels could not be read and the
	// namespaceSelector needs more than its name.
	NamespaceUnknown = "namespace_labels_unknown"
)

// Notes about the whole check.
const (
	NoteSamePod     = "same_pod"     // a pod can always reach itself
	NoteHostNetwork = "host_network" // policy behaviour for hostNetwork pods is left to the plugin
)

// RuleRef names one rule: the index in the policy's ingress or egress list.
type RuleRef struct {
	Policy string `json:"policy"`
	Rule   int    `json:"rule"`
}

// RuleMiss is a rule that did not allow the connection, or may not have.
// Rule is -1 for a policy with no rules in that direction.
type RuleMiss struct {
	Policy string `json:"policy"`
	Rule   int    `json:"rule"`
	Reason string `json:"reason"`
}

// Side is one direction of a check: egress from the source, or ingress into
// the destination.
type Side struct {
	// Isolated is true when at least one policy selects the pod for this direction.
	Isolated bool `json:"isolated"`
	// Policies are the policies that select it, by name.
	Policies  []string   `json:"policies"`
	Result    string     `json:"result"`
	AllowedBy []RuleRef  `json:"allowed_by"`
	Undecided []RuleMiss `json:"undecided"`
	Misses    []RuleMiss `json:"misses"`
}

// Verdict is the answer for one connection.
type Verdict struct {
	Result string `json:"result"`
	// Egress is nil when the source is an address, Ingress when the destination is.
	Egress  *Side    `json:"egress,omitempty"`
	Ingress *Side    `json:"ingress,omitempty"`
	Notes   []string `json:"notes"`
}

// Check decides whether policies allow a connection from src to dst on the
// destination pod's port (after any Service translation) and protocol.
func Check(policies []networkingv1.NetworkPolicy, src, dst Endpoint, protocol corev1.Protocol, port int32) Verdict {
	if protocol == "" {
		protocol = corev1.ProtocolTCP
	}
	v := Verdict{Notes: []string{}}
	if !src.External && !dst.External && src.Pod != "" && src.Pod == dst.Pod && src.Namespace == dst.Namespace {
		v.Result = Allowed
		v.Notes = append(v.Notes, NoteSamePod)
		return v
	}
	sorted := byName(policies)
	if !src.External {
		s := side(sorted, src, dst, dst, networkingv1.PolicyTypeEgress, protocol, port)
		v.Egress = &s
	}
	if !dst.External {
		s := side(sorted, dst, src, dst, networkingv1.PolicyTypeIngress, protocol, port)
		v.Ingress = &s
	}
	v.Result = combine(v.Egress, v.Ingress)
	if (!src.External && src.HostNetwork) || (!dst.External && dst.HostNetwork) {
		v.Notes = append(v.Notes, NoteHostNetwork)
		v.Result = Unknown
	}
	return v
}

// side evaluates one direction for self (the selected pods) against peer;
// dst is the connection's destination, whose ports named ports refer to.
func side(policies []networkingv1.NetworkPolicy, self, peer, dst Endpoint, dir networkingv1.PolicyType, protocol corev1.Protocol, port int32) Side {
	s := Side{Policies: []string{}, AllowedBy: []RuleRef{}, Undecided: []RuleMiss{}, Misses: []RuleMiss{}}
	for i := range policies {
		np := &policies[i]
		if np.Namespace != self.Namespace || !Affects(np, dir) || !selects(&np.Spec.PodSelector, self.Labels) {
			continue
		}
		s.Isolated = true
		s.Policies = append(s.Policies, np.Name)
		n := ruleCount(np, dir)
		if n == 0 {
			s.Misses = append(s.Misses, RuleMiss{Policy: np.Name, Rule: -1, Reason: MissNoRules})
			continue
		}
		for r := 0; r < n; r++ {
			peers, ports := rule(np, dir, r)
			pm := matchPeers(np.Namespace, peers, peer)
			miss := MissPeer
			if pm != "" {
				miss = matchPorts(ports, dst, protocol, port)
			}
			switch {
			case miss != "":
				s.Misses = append(s.Misses, RuleMiss{Policy: np.Name, Rule: r, Reason: miss})
			case pm == matched:
				s.AllowedBy = append(s.AllowedBy, RuleRef{Policy: np.Name, Rule: r})
			default:
				s.Undecided = append(s.Undecided, RuleMiss{Policy: np.Name, Rule: r, Reason: pm})
			}
		}
	}
	switch {
	case !s.Isolated, len(s.AllowedBy) > 0:
		s.Result = Allowed
	case len(s.Undecided) > 0:
		s.Result = Unknown
	default:
		s.Result = Denied
	}
	return s
}

func combine(sides ...*Side) string {
	result := Allowed
	for _, s := range sides {
		if s == nil {
			continue
		}
		switch s.Result {
		case Denied:
			return Denied
		case Unknown:
			result = Unknown
		}
	}
	return result
}

// Affects reports whether np applies to the direction, with the defaults of
// the API: every policy affects ingress unless policyTypes says otherwise, and
// egress only when it has egress rules.
func Affects(np *networkingv1.NetworkPolicy, dir networkingv1.PolicyType) bool {
	if len(np.Spec.PolicyTypes) > 0 {
		for _, t := range np.Spec.PolicyTypes {
			if t == dir {
				return true
			}
		}
		return false
	}
	if dir == networkingv1.PolicyTypeIngress {
		return true
	}
	return len(np.Spec.Egress) > 0
}

func ruleCount(np *networkingv1.NetworkPolicy, dir networkingv1.PolicyType) int {
	if dir == networkingv1.PolicyTypeIngress {
		return len(np.Spec.Ingress)
	}
	return len(np.Spec.Egress)
}

func rule(np *networkingv1.NetworkPolicy, dir networkingv1.PolicyType, i int) ([]networkingv1.NetworkPolicyPeer, []networkingv1.NetworkPolicyPort) {
	if dir == networkingv1.PolicyTypeIngress {
		return np.Spec.Ingress[i].From, np.Spec.Ingress[i].Ports
	}
	return np.Spec.Egress[i].To, np.Spec.Egress[i].Ports
}

// matched is a definite peer match; "" is none, and the other values are the
// undecided reasons.
const matched = "matched"

// matchPeers: an empty list matches every peer; otherwise the best answer of
// its entries (a definite match, then an undecided one, then none).
func matchPeers(policyNS string, peers []networkingv1.NetworkPolicyPeer, ep Endpoint) string {
	if len(peers) == 0 {
		return matched
	}
	best := ""
	for _, p := range peers {
		switch m := matchPeer(policyNS, p, ep); m {
		case matched:
			return matched
		case NamespaceUnknown:
			best = NamespaceUnknown
		case PodIPBlock:
			if best == "" {
				best = PodIPBlock
			}
		}
	}
	return best
}

func matchPeer(policyNS string, p networkingv1.NetworkPolicyPeer, ep Endpoint) string {
	if p.IPBlock != nil {
		if p.PodSelector != nil || p.NamespaceSelector != nil || !inBlock(p.IPBlock, ep.IPs) {
			return ""
		}
		if ep.External {
			return matched
		}
		return PodIPBlock
	}
	if ep.External || (p.PodSelector == nil && p.NamespaceSelector == nil) {
		return ""
	}
	ns := matched
	if p.NamespaceSelector == nil {
		if ep.Namespace != policyNS {
			return ""
		}
	} else if ns = matchNamespace(p.NamespaceSelector, ep); ns == "" {
		return ""
	}
	if p.PodSelector != nil && !selects(p.PodSelector, ep.Labels) {
		return ""
	}
	return ns
}

// matchNamespace answers matched, "" or NamespaceUnknown when the labels are
// not known and the selector needs more than the namespace's name.
func matchNamespace(sel *metav1.LabelSelector, ep Endpoint) string {
	s, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return ""
	}
	if ep.NamespaceLabels != nil {
		set := labels.Set{NamespaceNameLabel: ep.Namespace}
		for k, v := range ep.NamespaceLabels {
			set[k] = v
		}
		if s.Matches(set) {
			return matched
		}
		return ""
	}
	reqs, selectable := s.Requirements()
	if !selectable {
		return ""
	}
	known := labels.Set{NamespaceNameLabel: ep.Namespace}
	unknown := false
	for _, r := range reqs {
		if r.Key() != NamespaceNameLabel {
			unknown = true
		} else if !r.Matches(known) {
			return ""
		}
	}
	if unknown {
		return NamespaceUnknown
	}
	return matched
}

func selects(sel *metav1.LabelSelector, podLabels map[string]string) bool {
	s, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return false
	}
	return s.Matches(labels.Set(podLabels))
}

func inBlock(b *networkingv1.IPBlock, ips []netip.Addr) bool {
	cidr, err := netip.ParsePrefix(b.CIDR)
	if err != nil {
		return false
	}
	cidr = cidr.Masked()
	for _, ip := range ips {
		ip = ip.Unmap()
		if !cidr.Contains(ip) {
			continue
		}
		excluded := false
		for _, e := range b.Except {
			if ex, err := netip.ParsePrefix(e); err == nil && ex.Masked().Contains(ip) {
				excluded = true
				break
			}
		}
		if !excluded {
			return true
		}
	}
	return false
}

// matchPorts answers "" when the rule's ports take the connection, else the
// reason: MissNamedPort when a named port of the protocol is not declared by
// the destination, MissPort otherwise.
func matchPorts(ports []networkingv1.NetworkPolicyPort, dst Endpoint, protocol corev1.Protocol, port int32) string {
	if len(ports) == 0 {
		return ""
	}
	reason := MissPort
	for _, p := range ports {
		proto := corev1.ProtocolTCP
		if p.Protocol != nil {
			proto = *p.Protocol
		}
		if proto != protocol {
			continue
		}
		if p.Port == nil {
			return ""
		}
		if p.Port.Type == intstr.String {
			if dst.External {
				continue
			}
			num, ok := NamedPort(dst.Ports, p.Port.StrVal, proto)
			if !ok {
				reason = MissNamedPort
				continue
			}
			if num == port {
				return ""
			}
			continue
		}
		lo, hi := p.Port.IntVal, p.Port.IntVal
		if p.EndPort != nil {
			hi = *p.EndPort
		}
		if port >= lo && port <= hi {
			return ""
		}
	}
	return reason
}

// NamedPort finds the number of a container port by name and protocol.
func NamedPort(ports []corev1.ContainerPort, name string, protocol corev1.Protocol) (int32, bool) {
	for _, cp := range ports {
		proto := cp.Protocol
		if proto == "" {
			proto = corev1.ProtocolTCP
		}
		if cp.Name == name && proto == protocol {
			return cp.ContainerPort, true
		}
	}
	return 0, false
}

func byName(policies []networkingv1.NetworkPolicy) []networkingv1.NetworkPolicy {
	out := append([]networkingv1.NetworkPolicy(nil), policies...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out
}
