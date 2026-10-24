package k8s

import (
	"context"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"

	npeval "github.com/junginho0901/kubeast/services/pkg/netpol"
)

// The NetworkPolicy check: which policies apply to a pod or a workload, and
// whether they allow a connection. Everything is read as the signed-in user;
// the decision is services/pkg/netpol.

// netpolMaxPods caps the pods read behind one workload or Service.
const netpolMaxPods = 50

// NetpolRef is one end of a check as the caller names it.
type NetpolRef struct {
	Kind      string // pod, deployment, statefulset, daemonset, replicaset, job, cronjob, service, ip
	Namespace string
	Name      string
	IP        netip.Addr
}

var netpolKinds = map[string]string{
	"pod": "Pod", "deployment": "Deployment", "statefulset": "StatefulSet", "daemonset": "DaemonSet",
	"replicaset": "ReplicaSet", "job": "Job", "cronjob": "CronJob", "service": "Service",
}

// ParseNetpolRef reads "<kind>/<namespace>/<name>" or an IP address.
func ParseNetpolRef(s string, allowService bool) (NetpolRef, error) {
	s = strings.TrimSpace(s)
	if ip, err := netip.ParseAddr(s); err == nil {
		return NetpolRef{Kind: "ip", IP: ip.Unmap()}, nil
	}
	parts := strings.Split(s, "/")
	if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
		return NetpolRef{}, apierrors.NewBadRequest(fmt.Sprintf("%q is not <kind>/<namespace>/<name> or an IP address", s))
	}
	kind := strings.ToLower(parts[0])
	if _, ok := netpolKinds[kind]; !ok || (kind == "service" && !allowService) {
		return NetpolRef{}, apierrors.NewBadRequest(fmt.Sprintf("kind %q: use pod, deployment, statefulset, daemonset, replicaset, job, cronjob%s", parts[0], map[bool]string{true: " or service", false: ""}[allowService]))
	}
	return NetpolRef{Kind: kind, Namespace: parts[1], Name: parts[2]}, nil
}

func (r NetpolRef) String() string {
	if r.Kind == "ip" {
		return r.IP.String()
	}
	return r.Kind + "/" + r.Namespace + "/" + r.Name
}

// NetpolEnd describes a resolved end in the answer.
type NetpolEnd struct {
	Ref       string   `json:"ref"`
	Kind      string   `json:"kind"`
	Namespace string   `json:"namespace,omitempty"`
	Name      string   `json:"name,omitempty"`
	IPs       []string `json:"ips"`
	Pods      []string `json:"pods,omitempty"`
	// NamespaceLabelsKnown is false when the namespace could not be read.
	NamespaceLabelsKnown bool `json:"namespace_labels_known"`
}

// NetpolUnevaluated is a kind of network policy the check does not read.
type NetpolUnevaluated struct {
	Kind  string `json:"kind"`
	Group string `json:"group"`
	// Count is how many there are where they apply; -1 when they could not be listed.
	Count int `json:"count"`
}

// NetpolCheck is the answer for one destination port, and for a Service one
// group of its pods that share labels and ports.
type NetpolCheck struct {
	Pods        []string `json:"pods,omitempty"`
	Port        int32    `json:"port"`
	Protocol    string   `json:"protocol"`
	ServicePort string   `json:"service_port,omitempty"`
	npeval.Verdict
}

// NetpolCheckResult is the answer of CheckNetworkPolicy.
type NetpolCheckResult struct {
	Source      NetpolEnd           `json:"source"`
	Destination NetpolEnd           `json:"destination"`
	Result      string              `json:"result"` // allowed, denied, unknown, or mixed across checks
	Checks      []NetpolCheck       `json:"checks"`
	Unevaluated []NetpolUnevaluated `json:"unevaluated"`
	// Notes about the connection as a whole (noteDNSEgressDenied).
	Notes []string `json:"notes"`
	// Truncated: the workload or Service has more pods than were read.
	Truncated bool `json:"truncated,omitempty"`
}

// NetpolEffectiveResult is the answer of EffectiveNetworkPolicies.
type NetpolEffectiveResult struct {
	Kind        string `json:"kind"`
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	HostNetwork bool   `json:"host_network"`
	npeval.Effective
	Unevaluated []NetpolUnevaluated `json:"unevaluated"`
}

// netpolGroup is pods that the policies see alike: one pod, a workload's
// template, or the pods of a Service with the same labels and ports.
type netpolGroup struct {
	ep   npeval.Endpoint
	pods []string
}

type netpolResolved struct {
	end       NetpolEnd
	groups    []netpolGroup
	service   *corev1.Service
	truncated bool
}

// netpolReader reads what a check needs as the signed-in user.
type netpolReader struct {
	cs          kubernetes.Interface
	unevaluated func(ctx context.Context, namespace string) []NetpolUnevaluated
}

func (s *Service) netpolReader(ctx context.Context) (*netpolReader, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, ErrNoUser
	}
	return &netpolReader{cs: cs, unevaluated: s.netpolUnevaluated}, nil
}

// EffectiveNetworkPolicies lists the policies that select a pod, or a
// workload's pods by its template's labels.
func (s *Service) EffectiveNetworkPolicies(ctx context.Context, namespace, kind, name string) (*NetpolEffectiveResult, error) {
	r, err := s.netpolReader(ctx)
	if err != nil {
		return nil, err
	}
	return r.effective(ctx, namespace, kind, name)
}

// CheckNetworkPolicy decides whether NetworkPolicy allows src to reach dst.
// portSpec is a number, a container port name, a Service port name or number,
// or empty for every port the destination declares; protocol narrows it.
func (s *Service) CheckNetworkPolicy(ctx context.Context, src, dst NetpolRef, portSpec string, protocol corev1.Protocol) (*NetpolCheckResult, error) {
	r, err := s.netpolReader(ctx)
	if err != nil {
		return nil, err
	}
	return r.check(ctx, src, dst, portSpec, protocol)
}

func (r *netpolReader) effective(ctx context.Context, namespace, kind, name string) (*NetpolEffectiveResult, error) {
	k := strings.ToLower(kind)
	if _, ok := netpolKinds[k]; !ok || k == "service" {
		return nil, apierrors.NewBadRequest(fmt.Sprintf("kind %q: use Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob", kind))
	}
	labels, spec, _, err := r.template(ctx, NetpolRef{Kind: k, Namespace: namespace, Name: name})
	if err != nil {
		return nil, err
	}
	policies, err := r.policies(ctx, namespace)
	if err != nil {
		return nil, err
	}
	return &NetpolEffectiveResult{
		Kind: netpolKinds[k], Namespace: namespace, Name: name, HostNetwork: spec.HostNetwork,
		Effective:   npeval.Summarize(policies, namespace, labels),
		Unevaluated: r.unevaluated(ctx, namespace),
	}, nil
}

func (r *netpolReader) check(ctx context.Context, src, dst NetpolRef, portSpec string, protocol corev1.Protocol) (*NetpolCheckResult, error) {
	if src.Kind == "ip" && dst.Kind == "ip" {
		return nil, apierrors.NewBadRequest("one end must be pods: NetworkPolicy does not apply between two addresses")
	}
	if src.Kind == "service" {
		return nil, apierrors.NewBadRequest("a Service is not a source: name the pods or the workload")
	}
	nsLabels := map[string]map[string]string{}
	from, err := r.resolve(ctx, src, nsLabels)
	if err != nil {
		return nil, err
	}
	to, err := r.resolve(ctx, dst, nsLabels)
	if err != nil {
		return nil, err
	}
	var policies []networkingv1.NetworkPolicy
	seen := map[string]bool{}
	for _, ns := range []string{src.Namespace, dst.Namespace} {
		if ns == "" || seen[ns] {
			continue
		}
		seen[ns] = true
		list, err := r.policies(ctx, ns)
		if err != nil {
			return nil, err
		}
		policies = append(policies, list...)
	}
	res := &NetpolCheckResult{Source: from.end, Destination: to.end, Checks: []NetpolCheck{}, Notes: []string{}, Truncated: from.truncated || to.truncated}
	srcEP := from.groups[0].ep
	for _, g := range to.groups {
		targets, err := netpolTargets(g.ep, dst, to.service, portSpec, protocol)
		if err != nil {
			return nil, err
		}
		for _, t := range targets {
			c := NetpolCheck{Port: t.port, Protocol: string(t.protocol), ServicePort: t.servicePort}
			if dst.Kind != "pod" && dst.Kind != "ip" {
				c.Pods = g.pods
			}
			if t.missing != "" {
				c.Verdict = npeval.Verdict{Result: npeval.Unknown, Notes: []string{t.missing}}
			} else {
				c.Verdict = npeval.Check(policies, srcEP, g.ep, t.protocol, t.port)
			}
			res.Checks = append(res.Checks, c)
		}
	}
	if len(res.Checks) == 0 {
		return nil, apierrors.NewBadRequest("nothing to check: the destination declares no port of that protocol — give a port")
	}
	res.Result = res.Checks[0].Result
	if dst.Kind == "service" {
		dnsLabels, _ := r.namespaceLabels(ctx, "kube-system", nsLabels)
		if dnsEgressDenied(policies, srcEP, dnsLabels) {
			res.Notes = append(res.Notes, noteDNSEgressDenied)
		}
	}
	for _, c := range res.Checks[1:] {
		if c.Result != res.Result {
			res.Result = "mixed"
			break
		}
	}
	unevaluated := map[string]NetpolUnevaluated{}
	for ns := range seen {
		for _, u := range r.unevaluated(ctx, ns) {
			key := u.Group + "/" + u.Kind
			prev, ok := unevaluated[key]
			switch {
			case !ok:
			case u.Scope() == "cluster": // the same objects, listed again
				u = prev
			case prev.Count < 0 || u.Count < 0:
				u.Count = -1
			default:
				u.Count += prev.Count
			}
			unevaluated[key] = u
		}
	}
	res.Unevaluated = sortedUnevaluated(unevaluated)
	return res, nil
}

type netpolTarget struct {
	port        int32
	protocol    corev1.Protocol
	servicePort string
	missing     string // why the pod cannot take this Service port
}

// Notes of a Service check that never reaches policy evaluation, and of a
// source that cannot resolve the Service's name.
const (
	noteTargetPortMissing = "target_port_not_on_pod"
	noteDNSEgressDenied   = "dns_egress_denied"
)

// dnsEgressDenied: a Service is usually reached by its name, which needs
// cluster DNS (pods k8s-app=kube-dns in kube-system, UDP 53). The source's own
// egress policies decide whether it can ask; the Service IP works without.
func dnsEgressDenied(policies []networkingv1.NetworkPolicy, src npeval.Endpoint, dnsNamespaceLabels map[string]string) bool {
	dns := npeval.Endpoint{
		Namespace: "kube-system", NamespaceLabels: dnsNamespaceLabels, Labels: map[string]string{"k8s-app": "kube-dns"},
		Ports: []corev1.ContainerPort{{Name: "dns", ContainerPort: 53, Protocol: corev1.ProtocolUDP}, {Name: "dns-tcp", ContainerPort: 53, Protocol: corev1.ProtocolTCP}},
	}
	v := npeval.Check(policies, src, dns, corev1.ProtocolUDP, 53)
	return v.Egress != nil && v.Egress.Result == npeval.Denied
}

func netpolTargets(ep npeval.Endpoint, dst NetpolRef, svc *corev1.Service, portSpec string, protocol corev1.Protocol) ([]netpolTarget, error) {
	portSpec = strings.TrimSpace(portSpec)
	if svc != nil {
		var out []netpolTarget
		for _, sp := range svc.Spec.Ports {
			proto := sp.Protocol
			if proto == "" {
				proto = corev1.ProtocolTCP
			}
			if protocol != "" && proto != protocol {
				continue
			}
			if portSpec != "" && portSpec != strconv.Itoa(int(sp.Port)) && portSpec != sp.Name {
				continue
			}
			t := netpolTarget{protocol: proto, servicePort: fmt.Sprintf("%d/%s", sp.Port, proto)}
			if sp.Name != "" {
				t.servicePort = sp.Name + " " + t.servicePort
			}
			switch {
			case sp.TargetPort.Type == intstr.String:
				if n, ok := npeval.NamedPort(ep.Ports, sp.TargetPort.StrVal, proto); ok {
					t.port = n
				} else {
					t.missing = noteTargetPortMissing
				}
			case sp.TargetPort.IntVal != 0:
				t.port = sp.TargetPort.IntVal
			default:
				t.port = sp.Port
			}
			out = append(out, t)
		}
		if len(out) == 0 {
			return nil, apierrors.NewBadRequest(fmt.Sprintf("service %s/%s has no port %q", svc.Namespace, svc.Name, portSpec))
		}
		return out, nil
	}
	if portSpec == "" {
		if dst.Kind == "ip" {
			return nil, apierrors.NewBadRequest("give a port for an address")
		}
		var out []netpolTarget
		for _, cp := range ep.Ports {
			proto := cp.Protocol
			if proto == "" {
				proto = corev1.ProtocolTCP
			}
			if protocol != "" && proto != protocol {
				continue
			}
			out = append(out, netpolTarget{port: cp.ContainerPort, protocol: proto})
		}
		return out, nil
	}
	if protocol == "" {
		protocol = corev1.ProtocolTCP
	}
	if n, err := strconv.Atoi(portSpec); err == nil {
		if n < 1 || n > 65535 {
			return nil, apierrors.NewBadRequest(fmt.Sprintf("port %d is outside 1-65535", n))
		}
		return []netpolTarget{{port: int32(n), protocol: protocol}}, nil
	}
	if dst.Kind == "ip" {
		return nil, apierrors.NewBadRequest("an address has no named ports: give a number")
	}
	n, ok := npeval.NamedPort(ep.Ports, portSpec, protocol)
	if !ok {
		return nil, apierrors.NewBadRequest(fmt.Sprintf("the destination declares no %s port named %q", protocol, portSpec))
	}
	return []netpolTarget{{port: n, protocol: protocol}}, nil
}

func (r *netpolReader) resolve(ctx context.Context, ref NetpolRef, nsLabels map[string]map[string]string) (*netpolResolved, error) {
	if ref.Kind == "ip" {
		return &netpolResolved{
			end:    NetpolEnd{Ref: ref.String(), Kind: "IP", IPs: []string{ref.IP.String()}},
			groups: []netpolGroup{{ep: npeval.Endpoint{External: true, IPs: []netip.Addr{ref.IP}}}},
		}, nil
	}
	cs := r.cs
	labels, known := r.namespaceLabels(ctx, ref.Namespace, nsLabels)
	end := NetpolEnd{Ref: ref.String(), Kind: netpolKinds[ref.Kind], Namespace: ref.Namespace, Name: ref.Name, IPs: []string{}, NamespaceLabelsKnown: known}
	if ref.Kind == "service" {
		svc, err := cs.CoreV1().Services(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		if len(svc.Spec.Selector) == 0 {
			return nil, apierrors.NewBadRequest(fmt.Sprintf("service %s/%s has no selector: check its pods or address instead", ref.Namespace, ref.Name))
		}
		pods, truncated, err := r.pods(ctx, ref.Namespace, &metav1.LabelSelector{MatchLabels: svc.Spec.Selector})
		if err != nil {
			return nil, err
		}
		if len(pods) == 0 {
			return nil, apierrors.NewBadRequest(fmt.Sprintf("service %s/%s selects no running pods", ref.Namespace, ref.Name))
		}
		out := &netpolResolved{end: end, service: svc, truncated: truncated}
		byKey := map[string]int{}
		for i := range pods {
			p := &pods[i]
			ep := netpolPodEndpoint(p, labels)
			key := podGroupKey(p)
			if idx, ok := byKey[key]; ok {
				out.groups[idx].pods = append(out.groups[idx].pods, p.Name)
				out.groups[idx].ep.IPs = append(out.groups[idx].ep.IPs, ep.IPs...)
				continue
			}
			ep.Pod = ""
			byKey[key] = len(out.groups)
			out.groups = append(out.groups, netpolGroup{ep: ep, pods: []string{p.Name}})
		}
		for _, p := range pods {
			out.end.Pods = append(out.end.Pods, p.Name)
			out.end.IPs = append(out.end.IPs, podIPStrings(&p)...)
		}
		return out, nil
	}
	if ref.Kind == "pod" {
		p, err := cs.CoreV1().Pods(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		end.IPs = podIPStrings(p)
		return &netpolResolved{end: end, groups: []netpolGroup{{ep: netpolPodEndpoint(p, labels), pods: []string{p.Name}}}}, nil
	}
	tmplLabels, spec, selector, err := r.template(ctx, ref)
	if err != nil {
		return nil, err
	}
	ep := npeval.Endpoint{Namespace: ref.Namespace, NamespaceLabels: labels, Labels: tmplLabels, Ports: podPorts(spec), HostNetwork: spec.HostNetwork}
	out := &netpolResolved{end: end}
	if selector != nil {
		pods, truncated, err := r.pods(ctx, ref.Namespace, selector)
		if err != nil {
			return nil, err
		}
		out.truncated = truncated
		for i := range pods {
			for _, ip := range pods[i].Status.PodIPs {
				if a, err := netip.ParseAddr(ip.IP); err == nil {
					ep.IPs = append(ep.IPs, a)
				}
			}
			end.Pods = append(end.Pods, pods[i].Name)
			end.IPs = append(end.IPs, podIPStrings(&pods[i])...)
		}
	}
	out.end = end
	out.groups = []netpolGroup{{ep: ep, pods: end.Pods}}
	return out, nil
}

// netpolTemplate is the labels and pod spec that the policies see for a pod
// or a workload, and the selector of the workload's pods (nil for a pod or a CronJob).
func (r *netpolReader) template(ctx context.Context, ref NetpolRef) (map[string]string, corev1.PodSpec, *metav1.LabelSelector, error) {
	cs := r.cs
	get := metav1.GetOptions{}
	switch ref.Kind {
	case "pod":
		p, err := cs.CoreV1().Pods(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return p.Labels, p.Spec, nil, nil
	case "deployment":
		o, err := cs.AppsV1().Deployments(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return o.Spec.Template.Labels, o.Spec.Template.Spec, o.Spec.Selector, nil
	case "statefulset":
		o, err := cs.AppsV1().StatefulSets(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return o.Spec.Template.Labels, o.Spec.Template.Spec, o.Spec.Selector, nil
	case "daemonset":
		o, err := cs.AppsV1().DaemonSets(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return o.Spec.Template.Labels, o.Spec.Template.Spec, o.Spec.Selector, nil
	case "replicaset":
		o, err := cs.AppsV1().ReplicaSets(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return o.Spec.Template.Labels, o.Spec.Template.Spec, o.Spec.Selector, nil
	case "job":
		o, err := cs.BatchV1().Jobs(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		return o.Spec.Template.Labels, o.Spec.Template.Spec, o.Spec.Selector, nil
	case "cronjob":
		o, err := cs.BatchV1().CronJobs(ref.Namespace).Get(ctx, ref.Name, get)
		if err != nil {
			return nil, corev1.PodSpec{}, nil, err
		}
		t := o.Spec.JobTemplate.Spec.Template
		return t.Labels, t.Spec, nil, nil
	}
	return nil, corev1.PodSpec{}, nil, apierrors.NewBadRequest("unsupported kind " + ref.Kind)
}

func (r *netpolReader) pods(ctx context.Context, namespace string, sel *metav1.LabelSelector) ([]corev1.Pod, bool, error) {
	selector, err := metav1.LabelSelectorAsSelector(sel)
	if err != nil {
		return nil, false, apierrors.NewBadRequest(err.Error())
	}
	list, err := r.cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		return nil, false, err
	}
	var pods []corev1.Pod
	for _, p := range list.Items {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed || p.DeletionTimestamp != nil {
			continue
		}
		pods = append(pods, p)
	}
	sort.Slice(pods, func(i, j int) bool { return pods[i].Name < pods[j].Name })
	if len(pods) > netpolMaxPods {
		return pods[:netpolMaxPods], true, nil
	}
	return pods, false, nil
}

// netpolNamespaceLabels reads a namespace's labels as the user; nil when
// they may not read it (then only its name label is known).
func (r *netpolReader) namespaceLabels(ctx context.Context, name string, memo map[string]map[string]string) (map[string]string, bool) {
	if l, ok := memo[name]; ok {
		return l, l != nil
	}
	ns, err := r.cs.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		memo[name] = nil
		return nil, false
	}
	labels := ns.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	memo[name] = labels
	return labels, true
}

func (r *netpolReader) policies(ctx context.Context, namespace string) ([]networkingv1.NetworkPolicy, error) {
	list, err := r.cs.NetworkingV1().NetworkPolicies(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list network policies in %s: %w", namespace, err)
	}
	return list.Items, nil
}

// netpolOtherKinds are network policies of plugins and of the
// network-policy-api project, which the check does not evaluate.
var netpolOtherKinds = []struct {
	group, resource, kind string
	namespaced            bool
}{
	{"cilium.io", "ciliumnetworkpolicies", "CiliumNetworkPolicy", true},
	{"cilium.io", "ciliumclusterwidenetworkpolicies", "CiliumClusterwideNetworkPolicy", false},
	{"projectcalico.org", "networkpolicies", "NetworkPolicy", true},
	{"projectcalico.org", "globalnetworkpolicies", "GlobalNetworkPolicy", false},
	{"crd.projectcalico.org", "networkpolicies", "NetworkPolicy", true},
	{"crd.projectcalico.org", "globalnetworkpolicies", "GlobalNetworkPolicy", false},
	{"policy.networking.k8s.io", "clusternetworkpolicies", "ClusterNetworkPolicy", false},
	{"policy.networking.k8s.io", "adminnetworkpolicies", "AdminNetworkPolicy", false},
	{"policy.networking.k8s.io", "baselineadminnetworkpolicies", "BaselineAdminNetworkPolicy", false},
}

// Scope tells whether Count is for the namespaces checked or the cluster.
func (u NetpolUnevaluated) Scope() string {
	for _, k := range netpolOtherKinds {
		if k.group == u.Group && k.kind == u.Kind {
			if k.namespaced {
				return "namespace"
			}
			return "cluster"
		}
	}
	return "cluster"
}

// netpolUnevaluated lists the other policy kinds served by the cluster that
// have objects in namespace (namespaced kinds) or anywhere (cluster kinds).
// The Calico aggregated API (projectcalico.org) and its CRDs hold the same
// objects, so the CRDs are read only without it.
func (s *Service) netpolUnevaluated(ctx context.Context, namespace string) []NetpolUnevaluated {
	out := []NetpolUnevaluated{}
	lists, err := s.GetAPIResources(ctx)
	if err != nil {
		return out
	}
	served := map[string]string{} // group/resource -> version
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			if _, ok := served[gv.Group+"/"+r.Name]; !ok {
				served[gv.Group+"/"+r.Name] = gv.Version
			}
		}
	}
	dyn := s.dynamicCtx(ctx)
	for _, k := range netpolOtherKinds {
		version, ok := served[k.group+"/"+k.resource]
		if !ok || dyn == nil {
			continue
		}
		if k.group == "crd.projectcalico.org" {
			if _, aggregated := served["projectcalico.org/"+k.resource]; aggregated {
				continue
			}
		}
		res := dyn.Resource(schema.GroupVersionResource{Group: k.group, Version: version, Resource: k.resource})
		opts := metav1.ListOptions{Limit: 500}
		var count int
		var lerr error
		if k.namespaced {
			l, err := res.Namespace(namespace).List(ctx, opts)
			lerr = err
			if err == nil {
				for _, it := range l.Items {
					if !strings.HasPrefix(it.GetName(), "knp.") { // Calico's view of a Kubernetes NetworkPolicy
						count++
					}
				}
			}
		} else {
			l, err := res.List(ctx, opts)
			lerr = err
			if err == nil {
				count = len(l.Items)
			}
		}
		if lerr != nil {
			count = -1
		}
		if count != 0 {
			out = append(out, NetpolUnevaluated{Kind: k.kind, Group: k.group, Count: count})
		}
	}
	return out
}

func sortedUnevaluated(m map[string]NetpolUnevaluated) []NetpolUnevaluated {
	out := make([]NetpolUnevaluated, 0, len(m))
	for _, u := range m {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}

func netpolPodEndpoint(p *corev1.Pod, nsLabels map[string]string) npeval.Endpoint {
	ep := npeval.Endpoint{Namespace: p.Namespace, NamespaceLabels: nsLabels, Pod: p.Name, Labels: p.Labels, Ports: podPorts(p.Spec), HostNetwork: p.Spec.HostNetwork}
	for _, ip := range p.Status.PodIPs {
		if a, err := netip.ParseAddr(ip.IP); err == nil {
			ep.IPs = append(ep.IPs, a)
		}
	}
	return ep
}

// podPorts are the ports a named port can refer to: those of the containers
// and of the sidecars (init containers that keep running).
func podPorts(spec corev1.PodSpec) []corev1.ContainerPort {
	var out []corev1.ContainerPort
	for _, c := range spec.InitContainers {
		if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			out = append(out, c.Ports...)
		}
	}
	for _, c := range spec.Containers {
		out = append(out, c.Ports...)
	}
	return out
}

func podIPStrings(p *corev1.Pod) []string {
	out := make([]string, 0, len(p.Status.PodIPs))
	for _, ip := range p.Status.PodIPs {
		out = append(out, ip.IP)
	}
	return out
}

func podGroupKey(p *corev1.Pod) string {
	keys := make([]string, 0, len(p.Labels))
	for k, v := range p.Labels {
		keys = append(keys, k+"="+v)
	}
	sort.Strings(keys)
	var ports []string
	for _, cp := range podPorts(p.Spec) {
		ports = append(ports, fmt.Sprintf("%s:%d/%s", cp.Name, cp.ContainerPort, cp.Protocol))
	}
	sort.Strings(ports)
	return strings.Join(keys, ",") + "|" + strings.Join(ports, ",") + "|" + strconv.FormatBool(p.Spec.HostNetwork)
}
