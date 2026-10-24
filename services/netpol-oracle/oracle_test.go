// Package oracle checks services/pkg/netpol against np-guard/netpol-analyzer on
// generated namespaces, pods and NetworkPolicies: every source, destination,
// port and protocol of every scenario must get the same answer. It is a module
// of its own so the analyzer never becomes a dependency of a service.
//
// The analyzer answers through PolicyEngine.CheckIfAllowed. In v1.4.4 that
// takes a port entry with a protocol and no port as every protocol, so the
// analyzer gets each such entry written as the protocol's ports 1-65535,
// which the API defines as the same. Its connection sets (the list command)
// were tried first and lose allowed ports when a rule's named port is
// missing on the destination.
//
// netpol-analyzer assumes an ipBlock never selects a pod, so the comparison
// leaves out what netpol reports as depending on the network plugin (an
// ipBlock that covers a pod's IP) and keeps everything else.
//
//	NETPOL_ORACLE_SCENARIOS=20000 NETPOL_ORACLE_SEED=7 go test ./...
package oracle

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/np-guard/netpol-analyzer/pkg/logger"
	"github.com/np-guard/netpol-analyzer/pkg/netpol/eval"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/junginho0901/kubeast/services/pkg/netpol"
)

var (
	queryPorts = []int32{53, 80, 3868, 8080, 8081, 9090, 9100}
	protocols  = []corev1.Protocol{corev1.ProtocolTCP, corev1.ProtocolUDP, corev1.ProtocolSCTP}
	cidrs      = []networkingv1.IPBlock{
		{CIDR: "0.0.0.0/0"},
		{CIDR: "0.0.0.0/0", Except: []string{"10.244.0.0/16"}},
		{CIDR: "192.0.2.0/24"},
		{CIDR: "198.51.100.0/24", Except: []string{"198.51.100.7/32"}},
		{CIDR: "203.0.113.0/25"},
		{CIDR: "10.244.0.0/16"},
		{CIDR: "10.244.1.0/24"},
	}
	containerPorts = []corev1.ContainerPort{
		{Name: "http", ContainerPort: 8080},
		{Name: "dns", ContainerPort: 53, Protocol: corev1.ProtocolUDP},
		{Name: "metrics", ContainerPort: 9090},
		{Name: "diam", ContainerPort: 3868, Protocol: corev1.ProtocolSCTP},
		{Name: "web", ContainerPort: 80},
	}
	labelVocab = map[string][]string{"app": {"web", "db", "api"}, "role": {"client", "server"}, "tier": {"front", "back"}}
	nsVocab    = map[string][]string{"team": {"a", "b"}, "env": {"prod", "dev"}}
)

var policyName = regexp.MustCompile(`NetworkPolicy '[^']*' `)

type scenario struct {
	Namespaces []*corev1.Namespace          `json:"namespaces"`
	Pods       []*corev1.Pod                `json:"pods"`
	Policies   []networkingv1.NetworkPolicy `json:"policies"`
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

func TestAgainstNetpolAnalyzer(t *testing.T) {
	n := envInt("NETPOL_ORACLE_SCENARIOS", 300)
	seed := uint64(envInt("NETPOL_ORACLE_SEED", 1))
	r := rand.New(rand.NewPCG(seed, seed))
	compared, skipped, undecided := 0, 0, 0
	unanswered := map[string]int{}
	for i := 0; i < n; i++ {
		sc := generate(r)
		c, s, u := compare(t, i, sc, unanswered)
		compared, skipped, undecided = compared+c, skipped+s, undecided+u
		if t.Failed() {
			return
		}
	}
	t.Logf("seed %d: %d scenarios, %d checks compared, %d the analyzer could not answer, %d where netpol also reports a pod-IP ipBlock", seed, n, compared, skipped, undecided)
	for msg, count := range unanswered {
		t.Logf("not answered %d times: %s", count, msg)
	}
	if compared < n*100 {
		t.Fatalf("too few checks compared: %d", compared)
	}
}

func compare(t *testing.T, idx int, sc scenario, unanswered map[string]int) (compared, skipped, undecided int) {
	t.Helper()
	pe, err := eval.NewPolicyEngineWithOptionsList(eval.WithLogger(logger.NewDefaultLoggerWithVerbosity(logger.LowVerbosity)))
	must(t, err)
	for _, ns := range sc.Namespaces {
		must(t, pe.InsertObject(ns))
	}
	for _, p := range sc.Pods {
		must(t, pe.InsertObject(p))
	}
	for _, np := range explicitPortRanges(sc.Policies) {
		must(t, pe.InsertObject(np))
	}
	type end struct {
		key string
		ep  netpol.Endpoint
	}
	var ends []end
	nsLabels := map[string]map[string]string{}
	for _, ns := range sc.Namespaces {
		nsLabels[ns.Name] = ns.Labels
	}
	for _, p := range sc.Pods {
		ends = append(ends, end{p.Namespace + "/" + p.Name, netpol.Endpoint{
			Namespace: p.Namespace, NamespaceLabels: nsLabels[p.Namespace], Pod: p.Name, Labels: p.Labels,
			Ports: p.Spec.Containers[0].Ports, IPs: []netip.Addr{netip.MustParseAddr(p.Status.PodIP)},
		}})
	}
	// The analyzer splits the address space by every ipBlock the policies
	// name; each piece is tested at the first address of each of its ranges.
	_, _, ipPeers, err := pe.GetIPBlockPeersLists()
	must(t, err)
	for _, p := range ipPeers {
		for _, r := range strings.Split(p.String(), ",") {
			first := strings.SplitN(r, "-", 2)[0]
			ends = append(ends, end{first, netpol.Endpoint{External: true, IPs: []netip.Addr{netip.MustParseAddr(first)}}})
		}
	}
	for _, src := range ends {
		for _, dst := range ends {
			if src.ep.External && dst.ep.External {
				continue
			}
			for _, proto := range protocols {
				for _, port := range queryPorts {
					want, err := pe.CheckIfAllowed(src.key, dst.key, string(proto), strconv.Itoa(int(port)))
					if err != nil {
						skipped++
						unanswered[policyName.ReplaceAllString(err.Error(), "NetworkPolicy ")]++
						continue
					}
					v := netpol.Check(sc.Policies, src.ep, dst.ep, proto, port)
					got, viaPodIPBlock := withoutPodIPBlocks(v)
					if viaPodIPBlock {
						undecided++
					}
					compared++
					// A definite result must be the analyzer's; an unknown one only comes from a pod-IP ipBlock.
					definite := v.Result != netpol.Unknown
					if got != want || (definite && (v.Result == netpol.Allowed) != want) || (!definite && !viaPodIPBlock) {
						dump, _ := json.MarshalIndent(sc, "", "  ")
						verdict, _ := json.MarshalIndent(v, "", "  ")
						t.Fatalf("scenario %d: %s -> %s %s/%d: netpol %s (%v without pod-IP ipBlocks), netpol-analyzer %v\nverdict %s\nscenario %s", idx, src.key, dst.key, proto, port, v.Result, got, want, verdict, dump)
					}
				}
			}
		}
	}
	return compared, skipped, undecided
}

// explicitPortRanges writes each port entry that has no port as its
// protocol's ports 1-65535 (see the package comment).
func explicitPortRanges(policies []networkingv1.NetworkPolicy) []*networkingv1.NetworkPolicy {
	out := make([]*networkingv1.NetworkPolicy, 0, len(policies))
	for i := range policies {
		np := policies[i].DeepCopy()
		for r := range np.Spec.Ingress {
			fillPorts(np.Spec.Ingress[r].Ports)
		}
		for r := range np.Spec.Egress {
			fillPorts(np.Spec.Egress[r].Ports)
		}
		out = append(out, np)
	}
	return out
}

func fillPorts(ports []networkingv1.NetworkPolicyPort) {
	for i := range ports {
		if ports[i].Port == nil {
			first, last := intstr.FromInt32(1), int32(65535)
			ports[i].Port, ports[i].EndPort = &first, &last
		}
	}
}

// withoutPodIPBlocks is the answer when an ipBlock never selects a pod, as
// netpol-analyzer assumes, and whether netpol reported such an ipBlock.
func withoutPodIPBlocks(v netpol.Verdict) (allowed, viaPodIPBlock bool) {
	if v.Result == netpol.Allowed && len(v.Notes) > 0 {
		return true, false // the same pod
	}
	allowed = true
	for _, s := range []*netpol.Side{v.Egress, v.Ingress} {
		if s == nil {
			continue
		}
		for _, u := range s.Undecided {
			if u.Reason != netpol.PodIPBlock {
				panic("unexpected undecided reason " + u.Reason)
			}
			viaPodIPBlock = true
		}
		if s.Isolated && len(s.AllowedBy) == 0 {
			allowed = false
		}
	}
	return allowed, viaPodIPBlock
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func generate(r *rand.Rand) scenario {
	var sc scenario
	for i := 0; i < 2+r.IntN(3); i++ {
		name := fmt.Sprintf("ns%d", i)
		labels := pickLabels(r, nsVocab)
		labels[netpol.NamespaceNameLabel] = name
		sc.Namespaces = append(sc.Namespaces, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}})
	}
	for i := 0; i < 3+r.IntN(6); i++ {
		nsIdx := r.IntN(len(sc.Namespaces))
		var ports []corev1.ContainerPort
		for _, cp := range containerPorts {
			if r.IntN(3) == 0 {
				ports = append(ports, cp)
			}
		}
		ip := fmt.Sprintf("10.244.%d.%d", nsIdx, i+2)
		sc.Pods = append(sc.Pods, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: sc.Namespaces[nsIdx].Name, Name: fmt.Sprintf("pod%d", i), Labels: pickLabels(r, labelVocab)},
			Spec:       corev1.PodSpec{NodeName: "node", Containers: []corev1.Container{{Name: "c", Ports: ports}}},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning, HostIP: "172.18.0.2", PodIP: ip, PodIPs: []corev1.PodIP{{IP: ip}}},
		})
	}
	for i := 0; i < r.IntN(7); i++ {
		np := networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{
			Namespace: sc.Namespaces[r.IntN(len(sc.Namespaces))].Name, Name: fmt.Sprintf("np%d", i),
		}}
		np.Spec.PodSelector = *selector(r, labelVocab)
		switch r.IntN(4) {
		case 1:
			np.Spec.PolicyTypes = []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}
		case 2:
			np.Spec.PolicyTypes = []networkingv1.PolicyType{networkingv1.PolicyTypeEgress}
		case 3:
			np.Spec.PolicyTypes = []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress}
		}
		for j := 0; j < r.IntN(4); j++ {
			np.Spec.Ingress = append(np.Spec.Ingress, networkingv1.NetworkPolicyIngressRule{From: peers(r), Ports: rulePorts(r)})
		}
		for j := 0; j < r.IntN(4); j++ {
			np.Spec.Egress = append(np.Spec.Egress, networkingv1.NetworkPolicyEgressRule{To: peers(r), Ports: rulePorts(r)})
		}
		sc.Policies = append(sc.Policies, np)
	}
	return sc
}

func pickLabels(r *rand.Rand, vocab map[string][]string) map[string]string {
	out := map[string]string{}
	for _, k := range sortedKeys(vocab) {
		if r.IntN(2) == 0 {
			out[k] = vocab[k][r.IntN(len(vocab[k]))]
		}
	}
	return out
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// selector: empty (everything) a third of the time, else matchLabels and/or
// matchExpressions over the vocabulary.
func selector(r *rand.Rand, vocab map[string][]string) *metav1.LabelSelector {
	s := &metav1.LabelSelector{}
	if r.IntN(3) == 0 {
		return s
	}
	keys := sortedKeys(vocab)
	if r.IntN(2) == 0 {
		k := keys[r.IntN(len(keys))]
		s.MatchLabels = map[string]string{k: vocab[k][r.IntN(len(vocab[k]))]}
	}
	if r.IntN(2) == 0 || s.MatchLabels == nil {
		k := keys[r.IntN(len(keys))]
		req := metav1.LabelSelectorRequirement{Key: k}
		switch r.IntN(4) {
		case 0:
			req.Operator, req.Values = metav1.LabelSelectorOpIn, []string{vocab[k][r.IntN(len(vocab[k]))]}
		case 1:
			req.Operator, req.Values = metav1.LabelSelectorOpNotIn, []string{vocab[k][r.IntN(len(vocab[k]))]}
		case 2:
			req.Operator = metav1.LabelSelectorOpExists
		default:
			req.Operator = metav1.LabelSelectorOpDoesNotExist
		}
		s.MatchExpressions = []metav1.LabelSelectorRequirement{req}
	}
	return s
}

func peers(r *rand.Rand) []networkingv1.NetworkPolicyPeer {
	var out []networkingv1.NetworkPolicyPeer
	for i := 0; i < r.IntN(4); i++ {
		switch r.IntN(4) {
		case 0:
			out = append(out, networkingv1.NetworkPolicyPeer{PodSelector: selector(r, labelVocab)})
		case 1:
			nsVocabWithName := map[string][]string{"team": nsVocab["team"], "env": nsVocab["env"], netpol.NamespaceNameLabel: {"ns0", "ns1", "ns2"}}
			out = append(out, networkingv1.NetworkPolicyPeer{NamespaceSelector: selector(r, nsVocabWithName)})
		case 2:
			out = append(out, networkingv1.NetworkPolicyPeer{PodSelector: selector(r, labelVocab), NamespaceSelector: selector(r, nsVocab)})
		default:
			b := cidrs[r.IntN(len(cidrs))]
			out = append(out, networkingv1.NetworkPolicyPeer{IPBlock: &b})
		}
	}
	return out
}

func rulePorts(r *rand.Rand) []networkingv1.NetworkPolicyPort {
	var out []networkingv1.NetworkPolicyPort
	for i := 0; i < r.IntN(4); i++ {
		var p networkingv1.NetworkPolicyPort
		if k := r.IntN(4); k > 0 {
			proto := protocols[k-1]
			p.Protocol = &proto
		}
		switch r.IntN(4) {
		case 0: // every port of the protocol
		case 1:
			v := intstr.FromString(containerPorts[r.IntN(len(containerPorts))].Name)
			p.Port = &v
		default:
			n := queryPorts[r.IntN(len(queryPorts))]
			v := intstr.FromInt32(n)
			p.Port = &v
			if r.IntN(3) == 0 {
				end := n + int32(r.IntN(1200))
				p.EndPort = &end
			}
		}
		out = append(out, p)
	}
	return out
}
