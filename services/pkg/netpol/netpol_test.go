package netpol

import (
	"net/netip"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func pod(ns, name string, labels map[string]string, ip string, ports ...corev1.ContainerPort) Endpoint {
	e := Endpoint{Namespace: ns, NamespaceLabels: map[string]string{}, Pod: name, Labels: labels, Ports: ports}
	if ip != "" {
		e.IPs = []netip.Addr{netip.MustParseAddr(ip)}
	}
	return e
}

func external(ip string) Endpoint {
	return Endpoint{External: true, IPs: []netip.Addr{netip.MustParseAddr(ip)}}
}

func sel(kv ...string) *metav1.LabelSelector {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return &metav1.LabelSelector{MatchLabels: m}
}

func policy(ns, name string, podSel *metav1.LabelSelector, types []networkingv1.PolicyType) networkingv1.NetworkPolicy {
	np := networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}, Spec: networkingv1.NetworkPolicySpec{PolicyTypes: types}}
	if podSel != nil {
		np.Spec.PodSelector = *podSel
	}
	return np
}

func tcp(port int) networkingv1.NetworkPolicyPort {
	p := intstr.FromInt32(int32(port))
	return networkingv1.NetworkPolicyPort{Port: &p}
}

func named(name string, proto corev1.Protocol) networkingv1.NetworkPolicyPort {
	p := intstr.FromString(name)
	return networkingv1.NetworkPolicyPort{Port: &p, Protocol: &proto}
}

var (
	ingressOnly = []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}
	egressOnly  = []networkingv1.PolicyType{networkingv1.PolicyTypeEgress}
	web         = pod("shop", "web-1", map[string]string{"app": "web"}, "10.244.0.10", corev1.ContainerPort{Name: "http", ContainerPort: 8080})
	client      = pod("shop", "client-1", map[string]string{"role": "client"}, "10.244.0.11")
)

func TestNoPolicyAllowsEverything(t *testing.T) {
	v := Check(nil, client, web, "", 8080)
	if v.Result != Allowed || v.Egress.Isolated || v.Ingress.Isolated {
		t.Fatalf("want allowed and not isolated, got %+v", v)
	}
}

func TestDefaultDenyIngress(t *testing.T) {
	v := Check([]networkingv1.NetworkPolicy{policy("shop", "default-deny", nil, ingressOnly)}, client, web, "TCP", 8080)
	if v.Result != Denied || !v.Ingress.Isolated || v.Egress.Isolated {
		t.Fatalf("want denied by ingress isolation, got %+v", v)
	}
	want := []RuleMiss{{Policy: "default-deny", Rule: -1, Reason: MissNoRules}}
	if !reflect.DeepEqual(v.Ingress.Misses, want) {
		t.Fatalf("misses = %+v, want %+v", v.Ingress.Misses, want)
	}
}

func TestPolicyTypesDefault(t *testing.T) {
	// No policyTypes and no egress rules: ingress only. With egress rules: egress too.
	ingressDefault := policy("shop", "a", sel("role", "client"), nil)
	if Check([]networkingv1.NetworkPolicy{ingressDefault}, client, web, "", 8080).Egress.Isolated {
		t.Fatal("a policy without egress rules must not isolate egress")
	}
	withEgress := policy("shop", "b", sel("role", "client"), nil)
	withEgress.Spec.Egress = []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "db")}}}}
	v := Check([]networkingv1.NetworkPolicy{withEgress}, client, web, "", 8080)
	if !v.Egress.Isolated || v.Result != Denied || !reflect.DeepEqual(v.Egress.Misses, []RuleMiss{{Policy: "b", Rule: 0, Reason: MissPeer}}) {
		t.Fatalf("egress rules imply Egress: %+v", v.Egress)
	}
	if !Check([]networkingv1.NetworkPolicy{withEgress}, web, client, "", 80).Ingress.Isolated {
		t.Fatal("every policy affects ingress by default")
	}
}

// The documentation's example: one entry with both selectors is an AND, two entries an OR.
func TestNamespaceAndPodSelector(t *testing.T) {
	alice := pod("alice-ns", "c", map[string]string{"role": "client"}, "10.244.1.5")
	alice.NamespaceLabels = map[string]string{"user": "alice"}
	aliceOther := pod("alice-ns", "o", map[string]string{"role": "other"}, "10.244.1.6")
	aliceOther.NamespaceLabels = map[string]string{"user": "alice"}
	localClient := pod("shop", "lc", map[string]string{"role": "client"}, "10.244.0.20")

	and := policy("shop", "and", sel("app", "web"), ingressOnly)
	and.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("user", "alice"), PodSelector: sel("role", "client")}}}}
	or := policy("shop", "or", sel("app", "web"), ingressOnly)
	or.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("user", "alice")}, {PodSelector: sel("role", "client")}}}}

	cases := []struct {
		p    networkingv1.NetworkPolicy
		src  Endpoint
		want string
	}{
		{and, alice, Allowed}, {and, aliceOther, Denied}, {and, localClient, Denied},
		{or, alice, Allowed}, {or, aliceOther, Allowed}, {or, localClient, Allowed},
	}
	for _, c := range cases {
		if got := Check([]networkingv1.NetworkPolicy{c.p}, c.src, web, "", 8080).Result; got != c.want {
			t.Errorf("%s from %s/%s: %s, want %s", c.p.Name, c.src.Namespace, c.src.Pod, got, c.want)
		}
	}
}

func TestNamespaceLabelsUnknown(t *testing.T) {
	src := pod("ops", "x", map[string]string{"role": "client"}, "10.244.2.2")
	src.NamespaceLabels = nil
	byLabel := policy("shop", "by-label", sel("app", "web"), ingressOnly)
	byLabel.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel("team", "ops")}}}}
	v := Check([]networkingv1.NetworkPolicy{byLabel}, src, web, "", 8080)
	if v.Result != Unknown || !reflect.DeepEqual(v.Ingress.Undecided, []RuleMiss{{Policy: "by-label", Rule: 0, Reason: NamespaceUnknown}}) {
		t.Fatalf("a selector on unread labels is undecided: %+v", v)
	}
	byName := policy("shop", "by-name", sel("app", "web"), ingressOnly)
	byName.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel(NamespaceNameLabel, "ops")}}}}
	if got := Check([]networkingv1.NetworkPolicy{byName}, src, web, "", 8080).Result; got != Allowed {
		t.Fatalf("the name label is always known: %s", got)
	}
	// The name decides "no" even when another label is unknown.
	both := policy("shop", "both", sel("app", "web"), ingressOnly)
	both.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: sel(NamespaceNameLabel, "other", "team", "ops")}}}}
	if got := Check([]networkingv1.NetworkPolicy{both}, src, web, "", 8080).Result; got != Denied {
		t.Fatalf("a name that does not match is a definite no: %s", got)
	}
}

func TestPorts(t *testing.T) {
	udp := corev1.ProtocolUDP
	end := int32(9000)
	rangePort := tcp(8000)
	rangePort.EndPort = &end
	cases := []struct {
		name  string
		ports []networkingv1.NetworkPolicyPort
		proto corev1.Protocol
		port  int32
		want  string
		miss  string
	}{
		{"no ports = every port", nil, "TCP", 1234, Allowed, ""},
		{"number", []networkingv1.NetworkPolicyPort{tcp(8080)}, "TCP", 8080, Allowed, ""},
		{"protocol defaults to TCP", []networkingv1.NetworkPolicyPort{tcp(8080)}, "UDP", 8080, Denied, MissPort},
		{"protocol without port = every port", []networkingv1.NetworkPolicyPort{{Protocol: &udp}}, "UDP", 53, Allowed, ""},
		{"endPort is inclusive", []networkingv1.NetworkPolicyPort{rangePort}, "TCP", 9000, Allowed, ""},
		{"endPort upper bound", []networkingv1.NetworkPolicyPort{rangePort}, "TCP", 9001, Denied, MissPort},
		{"named port on the destination", []networkingv1.NetworkPolicyPort{named("http", "TCP")}, "TCP", 8080, Allowed, ""},
		{"named port, other number", []networkingv1.NetworkPolicyPort{named("http", "TCP")}, "TCP", 8081, Denied, MissPort},
		{"named port the destination lacks", []networkingv1.NetworkPolicyPort{named("metrics", "TCP")}, "TCP", 8080, Denied, MissNamedPort},
		{"named port of another protocol", []networkingv1.NetworkPolicyPort{named("http", "UDP")}, "UDP", 8080, Denied, MissNamedPort},
	}
	for _, c := range cases {
		p := policy("shop", "p", sel("app", "web"), ingressOnly)
		p.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{Ports: c.ports}}
		v := Check([]networkingv1.NetworkPolicy{p}, client, web, c.proto, c.port)
		if v.Result != c.want {
			t.Errorf("%s: %s, want %s", c.name, v.Result, c.want)
		}
		if c.miss != "" && (len(v.Ingress.Misses) != 1 || v.Ingress.Misses[0].Reason != c.miss) {
			t.Errorf("%s: misses %+v, want reason %s", c.name, v.Ingress.Misses, c.miss)
		}
	}
}

func TestEgressNamedPortRefersToDestination(t *testing.T) {
	p := policy("shop", "egress", sel("role", "client"), egressOnly)
	p.Spec.Egress = []networkingv1.NetworkPolicyEgressRule{{Ports: []networkingv1.NetworkPolicyPort{named("http", "TCP")}}}
	if got := Check([]networkingv1.NetworkPolicy{p}, client, web, "TCP", 8080).Result; got != Allowed {
		t.Fatalf("web declares http=8080: %s", got)
	}
	if got := Check([]networkingv1.NetworkPolicy{p}, client, external("192.0.2.1"), "TCP", 8080).Result; got != Denied {
		t.Fatalf("an address has no named ports: %s", got)
	}
}

func TestIPBlock(t *testing.T) {
	p := policy("shop", "out", sel("role", "client"), egressOnly)
	p.Spec.Egress = []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{{IPBlock: &networkingv1.IPBlock{CIDR: "0.0.0.0/0", Except: []string{"192.0.2.0/24"}}}}}}
	policies := []networkingv1.NetworkPolicy{p}
	if got := Check(policies, client, external("198.51.100.7"), "", 443).Result; got != Allowed {
		t.Fatalf("inside the block: %s", got)
	}
	if got := Check(policies, client, external("192.0.2.9"), "", 443).Result; got != Denied {
		t.Fatalf("in except: %s", got)
	}
	v := Check(policies, client, web, "", 8080)
	if v.Result != Unknown || !reflect.DeepEqual(v.Egress.Undecided, []RuleMiss{{Policy: "out", Rule: 0, Reason: PodIPBlock}}) {
		t.Fatalf("an ipBlock that covers a pod IP depends on the plugin: %+v", v.Egress)
	}
	// A selector rule that allows it decides, whatever the ipBlock does.
	p.Spec.Egress = append(p.Spec.Egress, networkingv1.NetworkPolicyEgressRule{To: []networkingv1.NetworkPolicyPeer{{PodSelector: sel("app", "web")}}})
	if got := Check([]networkingv1.NetworkPolicy{p}, client, web, "", 8080).Result; got != Allowed {
		t.Fatalf("selector rule allows: %s", got)
	}
}

func TestBothDirectionsMustAllow(t *testing.T) {
	denyOut := policy("shop", "deny-out", sel("role", "client"), egressOnly)
	v := Check([]networkingv1.NetworkPolicy{denyOut}, client, web, "", 8080)
	if v.Result != Denied || v.Egress.Result != Denied || v.Ingress.Result != Allowed {
		t.Fatalf("egress denied is enough: %+v", v)
	}
	// A policy of another namespace does not select the pod.
	if got := Check([]networkingv1.NetworkPolicy{policy("other", "deny", nil, ingressOnly)}, client, web, "", 8080).Result; got != Allowed {
		t.Fatalf("other namespace: %s", got)
	}
}

func TestSamePodAndHostNetwork(t *testing.T) {
	deny := []networkingv1.NetworkPolicy{policy("shop", "deny", nil, []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress})}
	v := Check(deny, web, web, "", 8080)
	if v.Result != Allowed || !reflect.DeepEqual(v.Notes, []string{NoteSamePod}) {
		t.Fatalf("a pod reaches itself: %+v", v)
	}
	host := web
	host.Pod, host.HostNetwork = "node-agent", true
	v = Check(deny, client, host, "", 8080)
	if v.Result != Unknown || !reflect.DeepEqual(v.Notes, []string{NoteHostNetwork}) {
		t.Fatalf("hostNetwork is up to the plugin: %+v", v)
	}
}

func TestMatchExpressions(t *testing.T) {
	p := policy("shop", "expr", &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "app", Operator: metav1.LabelSelectorOpIn, Values: []string{"web", "api"}}}}, ingressOnly)
	p.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "role", Operator: metav1.LabelSelectorOpNotIn, Values: []string{"client"}}}}}}}}
	if got := Check([]networkingv1.NetworkPolicy{p}, client, web, "", 8080).Result; got != Denied {
		t.Fatalf("NotIn client: %s", got)
	}
	other := pod("shop", "o", map[string]string{"role": "batch"}, "10.244.0.30")
	if got := Check([]networkingv1.NetworkPolicy{p}, other, web, "", 8080).Result; got != Allowed {
		t.Fatalf("role=batch passes NotIn: %s", got)
	}
}

func TestSummarize(t *testing.T) {
	allow := policy("shop", "allow-client", sel("app", "web"), nil)
	allow.Spec.Ingress = []networkingv1.NetworkPolicyIngressRule{{
		From:  []networkingv1.NetworkPolicyPeer{{PodSelector: sel("role", "client")}, {NamespaceSelector: &metav1.LabelSelector{}}, {IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8", Except: []string{"10.1.0.0/16"}}}},
		Ports: []networkingv1.NetworkPolicyPort{tcp(8080), named("http", "TCP")},
	}}
	e := Summarize([]networkingv1.NetworkPolicy{allow, policy("shop", "unrelated", sel("app", "db"), ingressOnly)}, "shop", web.Labels)
	if e.Egress.Isolated || len(e.Egress.Policies) != 0 {
		t.Fatalf("egress not isolated: %+v", e.Egress)
	}
	podSel, all := "role=client", ""
	want := Direction{Isolated: true, Policies: []PolicyRules{{Name: "allow-client", Rules: []RuleSummary{{
		Peers: []PeerSummary{{PodSelector: &podSel}, {NamespaceSelector: &all}, {CIDR: "10.0.0.0/8", Except: []string{"10.1.0.0/16"}}},
		Ports: []PortSummary{{Protocol: "TCP", Port: "8080"}, {Protocol: "TCP", Port: "http"}},
	}}}}}
	if !reflect.DeepEqual(e.Ingress, want) {
		t.Fatalf("ingress = %+v\nwant %+v", e.Ingress, want)
	}
}
