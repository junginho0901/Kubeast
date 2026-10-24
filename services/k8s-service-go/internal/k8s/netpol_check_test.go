package k8s

import (
	"context"
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	fakediscovery "k8s.io/client-go/discovery/fake"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	npeval "github.com/junginho0901/kubeast/services/pkg/netpol"
)

func npPod(ns, name, ip string, labels map[string]string, ports ...corev1.ContainerPort) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Ports: ports}}},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning, PodIP: ip, PodIPs: []corev1.PodIP{{IP: ip}}},
	}
}

func npNamespace(name string, labels map[string]string) *corev1.Namespace {
	l := map[string]string{"kubernetes.io/metadata.name": name}
	for k, v := range labels {
		l[k] = v
	}
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: l}}
}

// shop: web pods behind Service web (port 80 -> named port http=8080), a db
// pod, ingress to web only from role=client pods or namespace team=ops.
func netpolFixture() []runtime.Object {
	tcp := intstr.FromString("http")
	return []runtime.Object{
		npNamespace("shop", nil), npNamespace("ops", map[string]string{"team": "ops"}), npNamespace("other", nil),
		npPod("shop", "web-1", "10.244.0.10", map[string]string{"app": "web"}, corev1.ContainerPort{Name: "http", ContainerPort: 8080}),
		npPod("shop", "web-2", "10.244.0.11", map[string]string{"app": "web"}, corev1.ContainerPort{Name: "http", ContainerPort: 8080}),
		npPod("shop", "client-1", "10.244.0.20", map[string]string{"role": "client", "app": "client"}),
		npPod("shop", "db-0", "10.244.0.30", map[string]string{"app": "db"}, corev1.ContainerPort{Name: "pg", ContainerPort: 5432}, corev1.ContainerPort{Name: "metrics", ContainerPort: 9187}),
		npPod("ops", "probe", "10.244.1.5", map[string]string{"app": "probe"}),
		npPod("other", "stranger", "10.244.2.5", map[string]string{"app": "stranger"}),
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "client"},
			Spec: appsv1.DeploymentSpec{
				Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "client"}},
				Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"role": "client", "app": "client"}}},
			},
		},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web"},
			Spec:       corev1.ServiceSpec{Selector: map[string]string{"app": "web"}, Ports: []corev1.ServicePort{{Name: "http", Port: 80, TargetPort: tcp}}},
		},
		&networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-ingress"},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{
					{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"role": "client"}}},
					{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"team": "ops"}}},
				}}},
			},
		},
	}
}

func newNetpolReader(objs ...runtime.Object) (*netpolReader, *fake.Clientset) {
	cs := fake.NewSimpleClientset(objs...)
	return &netpolReader{cs: cs, unevaluated: func(context.Context, string) []NetpolUnevaluated { return []NetpolUnevaluated{} }}, cs
}

func mustRef(t *testing.T, s string, service bool) NetpolRef {
	t.Helper()
	r, err := ParseNetpolRef(s, service)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestNetpolCheckServiceTranslatesPorts(t *testing.T) {
	r, _ := newNetpolReader(netpolFixture()...)
	res, err := r.check(context.Background(), mustRef(t, "pod/shop/client-1", false), mustRef(t, "service/shop/web", true), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Result != npeval.Allowed || len(res.Checks) != 1 {
		t.Fatalf("want one allowed check, got %+v", res)
	}
	c := res.Checks[0]
	if c.Port != 8080 || c.ServicePort != "http 80/TCP" || !reflect.DeepEqual(c.Pods, []string{"web-1", "web-2"}) {
		t.Fatalf("service port 80 -> named target port http=8080 on both pods: %+v", c)
	}
	if !reflect.DeepEqual(c.Ingress.AllowedBy, []npeval.RuleRef{{Policy: "web-ingress", Rule: 0}}) {
		t.Fatalf("allowed by: %+v", c.Ingress.AllowedBy)
	}
	if !reflect.DeepEqual(res.Destination.Pods, []string{"web-1", "web-2"}) || len(res.Destination.IPs) != 2 {
		t.Fatalf("destination: %+v", res.Destination)
	}
}

func TestNetpolCheckDeniedAndNamespaceSelector(t *testing.T) {
	r, _ := newNetpolReader(netpolFixture()...)
	res, err := r.check(context.Background(), mustRef(t, "pod/other/stranger", false), mustRef(t, "pod/shop/web-1", true), "8080", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Result != npeval.Denied {
		t.Fatalf("stranger is neither role=client nor in team=ops: %+v", res)
	}
	res, err = r.check(context.Background(), mustRef(t, "pod/ops/probe", false), mustRef(t, "pod/shop/web-1", true), "http", "TCP")
	if err != nil {
		t.Fatal(err)
	}
	if res.Result != npeval.Allowed || res.Checks[0].Port != 8080 {
		t.Fatalf("namespace team=ops is allowed, named port http resolves to 8080: %+v", res.Checks)
	}
}

func TestNetpolCheckWorkloadSourceAndAllPorts(t *testing.T) {
	r, _ := newNetpolReader(netpolFixture()...)
	res, err := r.check(context.Background(), mustRef(t, "deployment/shop/client", false), mustRef(t, "pod/shop/db-0", true), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Source.Kind != "Deployment" || !reflect.DeepEqual(res.Source.Pods, []string{"client-1"}) {
		t.Fatalf("source pods by the deployment's selector: %+v", res.Source)
	}
	if len(res.Checks) != 2 || res.Checks[0].Port != 5432 || res.Checks[1].Port != 9187 || res.Result != npeval.Allowed {
		t.Fatalf("no port = every declared port of db-0, nothing isolates db: %+v", res.Checks)
	}
}

func TestNetpolCheckNamespaceNotReadable(t *testing.T) {
	r, cs := newNetpolReader(netpolFixture()...)
	cs.PrependReactor("get", "namespaces", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, a.(k8stesting.GetAction).GetName(), nil)
	})
	res, err := r.check(context.Background(), mustRef(t, "pod/ops/probe", false), mustRef(t, "pod/shop/web-1", true), "8080", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Result != npeval.Unknown || res.Source.NamespaceLabelsKnown {
		t.Fatalf("team=ops cannot be read: unknown, got %+v", res)
	}
	if got := res.Checks[0].Ingress.Undecided; !reflect.DeepEqual(got, []npeval.RuleMiss{{Policy: "web-ingress", Rule: 0, Reason: npeval.NamespaceUnknown}}) {
		t.Fatalf("undecided: %+v", got)
	}
}

func TestNetpolCheckBadInput(t *testing.T) {
	r, _ := newNetpolReader(netpolFixture()...)
	ctx := context.Background()
	for _, c := range []struct {
		src, dst, port string
	}{
		{"pod/shop/client-1", "203.0.113.9", ""},     // an address needs a port
		{"pod/shop/client-1", "203.0.113.9", "http"}, // and a number
		{"pod/shop/client-1", "pod/shop/web-1", "pg"},
		{"pod/shop/client-1", "pod/shop/web-1", "70000"},
		{"pod/shop/client-1", "service/shop/web", "443"},
		{"192.0.2.1", "203.0.113.9", "80"},
	} {
		_, err := r.check(ctx, mustRef(t, c.src, false), mustRef(t, c.dst, true), c.port, "")
		if !apierrors.IsBadRequest(err) {
			t.Errorf("%s -> %s :%s: want a bad request, got %v", c.src, c.dst, c.port, err)
		}
	}
	if _, err := r.check(ctx, mustRef(t, "pod/shop/missing", false), mustRef(t, "pod/shop/web-1", true), "80", ""); !apierrors.IsNotFound(err) {
		t.Errorf("missing pod: %v", err)
	}
	for _, s := range []string{"pod/shop", "secret/shop/x", "shop/web", ""} {
		if _, err := ParseNetpolRef(s, true); !apierrors.IsBadRequest(err) {
			t.Errorf("ParseNetpolRef(%q): %v", s, err)
		}
	}
	if _, err := ParseNetpolRef("service/shop/web", false); !apierrors.IsBadRequest(err) {
		t.Errorf("a service is not a source: %v", err)
	}
}

func TestNetpolEffective(t *testing.T) {
	r, _ := newNetpolReader(netpolFixture()...)
	res, err := r.effective(context.Background(), "shop", "Pod", "web-1")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Ingress.Isolated || res.Egress.Isolated || len(res.Ingress.Policies) != 1 || res.Ingress.Policies[0].Name != "web-ingress" {
		t.Fatalf("web-1: %+v", res)
	}
	res, err = r.effective(context.Background(), "shop", "deployment", "client")
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != "Deployment" || res.Ingress.Isolated || res.Egress.Isolated {
		t.Fatalf("nothing selects the client template: %+v", res)
	}
	if _, err := r.effective(context.Background(), "shop", "Service", "web"); !apierrors.IsBadRequest(err) {
		t.Fatalf("a service has no pod template: %v", err)
	}
}

func TestNetpolUnevaluated(t *testing.T) {
	cs := fake.NewSimpleClientset()
	disc := cs.Discovery().(*fakediscovery.FakeDiscovery)
	disc.Resources = []*metav1.APIResourceList{
		{GroupVersion: "cilium.io/v2", APIResources: []metav1.APIResource{
			{Name: "ciliumnetworkpolicies", Kind: "CiliumNetworkPolicy", Namespaced: true},
			{Name: "ciliumclusterwidenetworkpolicies", Kind: "CiliumClusterwideNetworkPolicy"},
		}},
		{GroupVersion: "projectcalico.org/v3", APIResources: []metav1.APIResource{{Name: "networkpolicies", Kind: "NetworkPolicy", Namespaced: true}}},
		{GroupVersion: "crd.projectcalico.org/v1", APIResources: []metav1.APIResource{{Name: "networkpolicies", Kind: "NetworkPolicy", Namespaced: true}}},
	}
	u := func(apiVersion, kind, ns, name string) *unstructured.Unstructured {
		o := &unstructured.Unstructured{}
		o.SetAPIVersion(apiVersion)
		o.SetKind(kind)
		o.SetNamespace(ns)
		o.SetName(name)
		return o
	}
	dyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		{Group: "cilium.io", Version: "v2", Resource: "ciliumnetworkpolicies"}:            "CiliumNetworkPolicyList",
		{Group: "cilium.io", Version: "v2", Resource: "ciliumclusterwidenetworkpolicies"}: "CiliumClusterwideNetworkPolicyList",
		{Group: "projectcalico.org", Version: "v3", Resource: "networkpolicies"}:          "NetworkPolicyList",
		{Group: "crd.projectcalico.org", Version: "v1", Resource: "networkpolicies"}:      "NetworkPolicyList",
	},
		u("cilium.io/v2", "CiliumNetworkPolicy", "shop", "l7"),
		u("cilium.io/v2", "CiliumNetworkPolicy", "other", "elsewhere"),
		u("projectcalico.org/v3", "NetworkPolicy", "shop", "default.allow-dns"),
		u("projectcalico.org/v3", "NetworkPolicy", "shop", "knp.default.web-ingress"),
		u("crd.projectcalico.org/v1", "NetworkPolicy", "shop", "default.allow-dns"),
	)
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{dynamic: dyn, discovery: disc})
	got := s.netpolUnevaluated(context.Background(), "shop")
	want := []NetpolUnevaluated{
		{Kind: "CiliumNetworkPolicy", Group: "cilium.io", Count: 1},
		{Kind: "NetworkPolicy", Group: "projectcalico.org", Count: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v (the cluster-wide kind has none, Calico CRDs are skipped behind its API, knp. is a Kubernetes policy)", got, want)
	}
}

func TestNetpolCheckServiceNameNeedsDNS(t *testing.T) {
	onlyWeb := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "client-egress"},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"role": "client"}},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
			Egress:      []networkingv1.NetworkPolicyEgressRule{{To: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}}}}},
		},
	}
	r, _ := newNetpolReader(append(netpolFixture(), onlyWeb)...)
	src, dst := mustRef(t, "pod/shop/client-1", false), mustRef(t, "service/shop/web", true)
	res, err := r.check(context.Background(), src, dst, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Result != npeval.Allowed || !reflect.DeepEqual(res.Notes, []string{noteDNSEgressDenied}) {
		t.Fatalf("the pods are reachable but kube-dns is not: %+v %v", res.Result, res.Notes)
	}
	udp := corev1.ProtocolUDP
	dnsPort := intstr.FromInt32(53)
	onlyWeb.Spec.Egress = append(onlyWeb.Spec.Egress, networkingv1.NetworkPolicyEgressRule{
		To: []networkingv1.NetworkPolicyPeer{{
			NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "kube-system"}},
			PodSelector:       &metav1.LabelSelector{MatchLabels: map[string]string{"k8s-app": "kube-dns"}},
		}},
		Ports: []networkingv1.NetworkPolicyPort{{Protocol: &udp, Port: &dnsPort}},
	})
	r, _ = newNetpolReader(append(netpolFixture(), onlyWeb)...)
	if res, err = r.check(context.Background(), src, dst, "", ""); err != nil || len(res.Notes) != 0 {
		t.Fatalf("DNS allowed: %v %v", res.Notes, err)
	}
	// Without an egress policy on the source there is nothing to say.
	r, _ = newNetpolReader(netpolFixture()...)
	if res, err = r.check(context.Background(), src, dst, "", ""); err != nil || len(res.Notes) != 0 {
		t.Fatalf("not isolated: %v %v", res.Notes, err)
	}
}
