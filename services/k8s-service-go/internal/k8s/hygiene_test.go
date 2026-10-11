package k8s

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var hygieneNow = time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)

func ptr[T any](v T) *T { return &v }

// compliantPod meets PSS restricted and every other check.
func compliantPod(ns, name string) corev1.Pod {
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name},
		Spec: corev1.PodSpec{
			ServiceAccountName: "app",
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot:   ptr(true),
				SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
			},
			Volumes: []corev1.Volume{{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}},
			Containers: []corev1.Container{{
				Name:  "app",
				Image: "registry.example.com/app:1.2.3",
				SecurityContext: &corev1.SecurityContext{
					AllowPrivilegeEscalation: ptr(false),
					Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
				},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("16Mi")},
					Limits:   corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("32Mi")},
				},
			}},
		},
	}
}

func labeledNS(name string) corev1.Namespace {
	return corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"pod-security.kubernetes.io/enforce": "restricted"}}}
}

func netpol(ns string) networkingv1.NetworkPolicy {
	return networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "default-deny"}}
}

func evaluate(in HygieneInput) HygieneReport {
	return EvaluateHygiene(in, HygieneOptions{ExcludeNamespaces: []string{"kube-system"}, TLSWarnDays: 30, TLSCriticalDays: 7, Now: hygieneNow})
}

func findingsOf(rep HygieneReport, check string) []HygieneFinding {
	var out []HygieneFinding
	for _, f := range rep.Findings {
		if f.Check == check {
			out = append(out, f)
		}
	}
	return out
}

func TestHygieneCompliantPodHasNoFindings(t *testing.T) {
	rep := evaluate(HygieneInput{
		Pods:            []corev1.Pod{compliantPod("apps", "web")},
		Namespaces:      []corev1.Namespace{labeledNS("apps")},
		NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")},
	})
	if len(rep.Findings) != 0 {
		t.Fatalf("findings = %+v, want none", rep.Findings)
	}
	if len(rep.Checks) != len(HygieneChecks) {
		t.Fatalf("checks = %d, want %d", len(rep.Checks), len(HygieneChecks))
	}
}

func TestHygieneBaselineViolations(t *testing.T) {
	p := compliantPod("apps", "bad")
	p.Spec.HostNetwork, p.Spec.HostPID = true, true
	p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{Name: "logs", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/var/log"}}})
	c := &p.Spec.Containers[0]
	c.SecurityContext.Privileged = ptr(true)
	c.SecurityContext.Capabilities.Add = []corev1.Capability{"CHOWN", "NET_RAW", "SYS_ADMIN"}
	c.Ports = []corev1.ContainerPort{{ContainerPort: 80, HostPort: 8080}}
	c.SecurityContext.ProcMount = ptr(corev1.UnmaskedProcMount)
	c.ReadinessProbe = &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Host: "10.0.0.1"}}}
	p.Spec.SecurityContext.Sysctls = []corev1.Sysctl{{Name: "net.ipv4.tcp_syncookies"}, {Name: "kernel.msgmax"}}
	p.Spec.SecurityContext.SeccompProfile = &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeUnconfined}
	p.Spec.SecurityContext.SELinuxOptions = &corev1.SELinuxOptions{User: "system_u"}
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{p}, Namespaces: []corev1.Namespace{labeledNS("apps")}, NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")}})

	want := map[string]string{
		"pss.privileged":      "privileged: app",
		"pss.host-namespaces": "hostNetwork, hostPID",
		"pss.hostpath":        "/var/log (logs)",
		"pss.host-ports":      "8080 (app)",
		"pss.capabilities":    "app adds NET_RAW, SYS_ADMIN",
	}
	for check, sub := range want {
		got := findingsOf(rep, check)
		if len(got) != 1 || !strings.Contains(got[0].Message, sub) {
			t.Errorf("%s = %+v, want one finding containing %q", check, got, sub)
		}
	}
	other := findingsOf(rep, "pss.other-baseline")
	if len(other) != 1 {
		t.Fatalf("pss.other-baseline = %+v", other)
	}
	for _, sub := range []string{"procMount Unmasked", "probe/lifecycle host", "sysctl kernel.msgmax", "seccomp Unconfined (pod)", "SELinux user system_u"} {
		if !strings.Contains(other[0].Message, sub) {
			t.Errorf("pss.other-baseline message %q lacks %q", other[0].Message, sub)
		}
	}
	if strings.Contains(other[0].Message, "tcp_syncookies") {
		t.Errorf("a safe sysctl was reported: %q", other[0].Message)
	}
	if got := findingsOf(rep, "pss.privileged")[0].Severity; got != HygieneCritical {
		t.Errorf("privileged severity = %s", got)
	}
	if f := findingsOf(rep, "pss.capabilities")[0]; f.MessageKey != "capabilities" || f.MessageArgs["added"] != "NET_RAW, SYS_ADMIN (app)" {
		t.Errorf("capabilities sentence = %q %v", f.MessageKey, f.MessageArgs)
	}
	everyFindingHasAKey(t, rep)
	if rep.Counts.Critical != 2 {
		t.Errorf("critical = %d, want 2 (privileged, host namespaces)", rep.Counts.Critical)
	}
}

func TestHygieneRestrictedGapsAreInfo(t *testing.T) {
	p := compliantPod("apps", "loose")
	p.Spec.SecurityContext = nil
	p.Spec.Containers[0].SecurityContext = nil
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{p}, Namespaces: []corev1.Namespace{labeledNS("apps")}, NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")}})
	got := findingsOf(rep, "pss.restricted")
	if len(got) != 1 || got[0].Severity != HygieneInfo {
		t.Fatalf("pss.restricted = %+v", got)
	}
	for _, sub := range []string{"allowPrivilegeEscalation", "runAsNonRoot", "seccomp", "capabilities drop ALL"} {
		if !strings.Contains(got[0].Message, sub) {
			t.Errorf("restricted message %q lacks %q", got[0].Message, sub)
		}
	}
	if len(findingsOf(rep, "pss.privileged")) != 0 || rep.Counts.Warning != 0 || rep.Counts.Critical != 0 {
		t.Errorf("restricted gaps must not count as warnings: %+v", rep.Counts)
	}
}

func TestHygieneImageTags(t *testing.T) {
	cases := map[string]bool{
		"nginx": true, "nginx:latest": true, "registry:5000/app": true, "registry:5000/app:latest": true,
		"nginx:1.27": false, "registry:5000/app:v1": false, "nginx@sha256:abc": false, "nginx:latest@sha256:abc": false,
	}
	for image, want := range cases {
		if got := imageLatest(image); got != want {
			t.Errorf("imageLatest(%q) = %v, want %v", image, got, want)
		}
	}
}

func TestHygieneResources(t *testing.T) {
	p := compliantPod("apps", "nolimits")
	p.Spec.Containers[0].Resources = corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m")}}
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{p}, Namespaces: []corev1.Namespace{labeledNS("apps")}, NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")}})
	if got := findingsOf(rep, "resources.memory-limit"); len(got) != 1 || got[0].Container != "app" {
		t.Errorf("memory-limit = %+v", got)
	}
	if got := findingsOf(rep, "resources.requests"); len(got) != 1 || got[0].Message != "no memory request" ||
		got[0].MessageKey != "requests" || got[0].MessageArgs["resources"] != "memory" {
		t.Errorf("requests = %+v", got)
	}
	everyFindingHasAKey(t, rep)
}

// The UI shows a finding through clusterHygiene.message.<key>: every finding carries one.
func everyFindingHasAKey(t *testing.T, rep HygieneReport) {
	t.Helper()
	for _, f := range rep.Findings {
		if f.MessageKey == "" {
			t.Errorf("%s %s/%s has no message key (message %q)", f.Check, f.Namespace, f.Name, f.Message)
		}
	}
}

func TestHygieneGroupsPodsByOwnerAndSkipsExcluded(t *testing.T) {
	var pods []corev1.Pod
	for _, n := range []string{"a", "b", "c"} {
		p := compliantPod("apps", "web-7d9f-"+n)
		p.Spec.Containers[0].Image = "nginx"
		p.Labels = map[string]string{"pod-template-hash": "7d9f"}
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-7d9f", Controller: ptr(true)}}
		pods = append(pods, p)
	}
	sys := compliantPod("kube-system", "kube-proxy-x")
	sys.Spec.HostNetwork = true
	pods = append(pods, sys)
	rep := evaluate(HygieneInput{Pods: pods, Namespaces: []corev1.Namespace{labeledNS("apps"), {ObjectMeta: metav1.ObjectMeta{Name: "kube-system"}}},
		NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")}})
	got := findingsOf(rep, "image.latest")
	if len(got) != 1 || got[0].Kind != "Deployment" || got[0].Name != "web" || got[0].Pods != 3 {
		t.Fatalf("image.latest = %+v, want one Deployment web with 3 pods", got)
	}
	if len(findingsOf(rep, "pss.host-namespaces")) != 0 || len(findingsOf(rep, "ns.pss-label")) != 0 {
		t.Errorf("excluded namespace kube-system was checked: %+v", rep.Findings)
	}
}

func TestHygieneExemptions(t *testing.T) {
	withReason := compliantPod("apps", "a")
	withReason.Spec.Containers[0].Image = "nginx"
	withReason.Annotations = map[string]string{HygieneExemptAnnotation: "image.latest", HygieneExemptReasonAnnotation: "vendor image without tags"}
	noReason := compliantPod("apps", "b")
	noReason.Spec.Containers[0].Image = "nginx"
	noReason.Annotations = map[string]string{HygieneExemptAnnotation: "image.latest"}
	nsWide := compliantPod("legacy", "c")
	nsWide.Spec.HostNetwork = true
	legacy := corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "legacy",
		Labels:      map[string]string{"pod-security.kubernetes.io/enforce": "privileged"},
		Annotations: map[string]string{HygieneExemptAnnotation: "*", HygieneExemptReasonAnnotation: "CNI agent namespace"}}}
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{withReason, noReason, nsWide},
		Namespaces:      []corev1.Namespace{labeledNS("apps"), legacy},
		NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps"), netpol("legacy")}})
	img := findingsOf(rep, "image.latest")
	if len(img) != 2 {
		t.Fatalf("image.latest = %+v", img)
	}
	byName := map[string]HygieneFinding{img[0].Name: img[0], img[1].Name: img[1]}
	if f := byName["a"]; !f.Exempt || f.ExemptReason != "vendor image without tags" {
		t.Errorf("pod with reason = %+v, want exempt", f)
	}
	if f := byName["b"]; f.Exempt || !f.ExemptNoReason || !strings.Contains(f.Message, "without "+HygieneExemptReasonAnnotation) {
		t.Errorf("pod without reason = %+v, want a finding that names the missing reason", f)
	}
	if f := findingsOf(rep, "pss.host-namespaces"); len(f) != 1 || !f[0].Exempt {
		t.Errorf("namespace-wide exemption = %+v", f)
	}
	if rep.Counts.Exempt != 2 || rep.Checks[7].Exempt != 1 || rep.Checks[7].Findings != 1 {
		t.Errorf("counts = %+v, image.latest summary = %+v", rep.Counts, rep.Checks[7])
	}
	if !rep.Findings[len(rep.Findings)-1].Exempt {
		t.Errorf("exempt findings should sort last: %+v", rep.Findings)
	}
}

func TestHygieneNamespaceChecks(t *testing.T) {
	p := compliantPod("default", "stray")
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{p},
		Namespaces: []corev1.Namespace{{ObjectMeta: metav1.ObjectMeta{Name: "default", Labels: map[string]string{"pod-security.kubernetes.io/warn": "baseline"}}}}})
	if f := findingsOf(rep, "ns.pss-label"); len(f) != 1 || !strings.Contains(f[0].Message, "warn=baseline") ||
		f[0].MessageKey != "pssLabelWarn" || f[0].MessageArgs["warn"] != "baseline" {
		t.Errorf("ns.pss-label = %+v", f)
	}
	if f := findingsOf(rep, "ns.network-policy"); len(f) != 1 || f[0].Message != "no NetworkPolicy (1 pods)" ||
		f[0].MessageKey != "networkPolicy" || f[0].MessageArgs["pods"] != "1" {
		t.Errorf("ns.network-policy = %+v", f)
	}
	everyFindingHasAKey(t, rep)
	if f := findingsOf(rep, "ns.default-used"); len(f) != 1 {
		t.Errorf("ns.default-used = %+v", f)
	}
	// An unreadable NetworkPolicy list must not turn into "no NetworkPolicy".
	rep = evaluate(HygieneInput{Namespaces: []corev1.Namespace{labeledNS("apps")}, Failed: map[string]bool{"networkpolicies": true},
		Collectors: []HygieneCollector{{What: "networkpolicies", Error: "forbidden"}}})
	if f := findingsOf(rep, "ns.network-policy"); len(f) != 0 || len(rep.Collectors) != 1 {
		t.Errorf("failed list: findings %+v collectors %+v", f, rep.Collectors)
	}
}

func TestHygieneDefaultServiceAccountToken(t *testing.T) {
	token := corev1.Volume{Name: "kube-api-access-x", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{
		Sources: []corev1.VolumeProjection{{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Path: "token"}}}}}}
	def := compliantPod("apps", "uses-default")
	def.Spec.ServiceAccountName = "default"
	def.Spec.Volumes = append(def.Spec.Volumes, token)
	own := compliantPod("apps", "own-sa")
	own.Spec.Volumes = append(own.Spec.Volumes, token)
	rep := evaluate(HygieneInput{Pods: []corev1.Pod{def, own}, Namespaces: []corev1.Namespace{labeledNS("apps")}, NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")}})
	if f := findingsOf(rep, "sa.default-token"); len(f) != 1 || f[0].Name != "uses-default" {
		t.Errorf("sa.default-token = %+v", f)
	}
}

func TestHygieneRBAC(t *testing.T) {
	rep := evaluate(HygieneInput{
		ClusterRoleBindings: []rbacv1.ClusterRoleBinding{
			{ObjectMeta: metav1.ObjectMeta{Name: "cluster-admin"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"}},
			{ObjectMeta: metav1.ObjectMeta{Name: "kubeadm:cluster-admins"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"}},
			{ObjectMeta: metav1.ObjectMeta{Name: "ci-deployer"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"},
				Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", Namespace: "ci", Name: "deployer"}}},
			{ObjectMeta: metav1.ObjectMeta{Name: "readers"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "view"}},
		},
		RoleBindings: []rbacv1.RoleBinding{
			{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "team-admin"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"}},
			{ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "sys"}, RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"}},
		},
		ClusterRoles: []rbacv1.ClusterRole{
			{ObjectMeta: metav1.ObjectMeta{Name: "tool-server"}, Rules: []rbacv1.PolicyRule{{Verbs: []string{"*"}, Resources: []string{"*"}, APIGroups: []string{"*"}}}},
			{ObjectMeta: metav1.ObjectMeta{Name: "system:controller:x"}, Rules: []rbacv1.PolicyRule{{Verbs: []string{"*"}}}},
			{ObjectMeta: metav1.ObjectMeta{Name: "aggregated"}, AggregationRule: &rbacv1.AggregationRule{}, Rules: []rbacv1.PolicyRule{{Verbs: []string{"*"}}}},
			{ObjectMeta: metav1.ObjectMeta{Name: "pod-reader"}, Rules: []rbacv1.PolicyRule{{Verbs: []string{"get", "list"}, Resources: []string{"pods"}}}},
		},
		Roles: []rbacv1.Role{{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "all-pods"}, Rules: []rbacv1.PolicyRule{{Verbs: []string{"get"}, Resources: []string{"*"}}}}},
	})
	admin := findingsOf(rep, "rbac.cluster-admin")
	if len(admin) != 2 {
		t.Fatalf("rbac.cluster-admin = %+v, want ci-deployer and apps/team-admin", admin)
	}
	if admin[0].Name != "team-admin" && admin[1].Name != "team-admin" {
		t.Errorf("RoleBinding to cluster-admin missing: %+v", admin)
	}
	for _, f := range admin {
		if f.Name == "ci-deployer" && (f.Message != "binds cluster-admin to ServiceAccount:ci/deployer" ||
			f.MessageKey != "clusterAdmin" || f.MessageArgs["subjects"] != "ServiceAccount:ci/deployer") {
			t.Errorf("ci-deployer = %q %q %v", f.Message, f.MessageKey, f.MessageArgs)
		}
		if f.Name == "team-admin" && !strings.HasPrefix(f.MessageKey, "clusterAdminInNamespace") {
			t.Errorf("team-admin key = %q", f.MessageKey)
		}
	}
	everyFindingHasAKey(t, rep)
	wild := findingsOf(rep, "rbac.wildcard")
	if len(wild) != 2 {
		t.Fatalf("rbac.wildcard = %+v, want tool-server and apps/all-pods", wild)
	}
}

func selfSigned(t *testing.T, notAfter time.Time, dns ...string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "e2e.example.com"}, DNSNames: dns,
		NotBefore: notAfter.Add(-90 * 24 * time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func tlsSecret(ns, name string, crt []byte) corev1.Secret {
	return corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}, Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{corev1.TLSCertKey: crt, corev1.TLSPrivateKeyKey: []byte("unused")}}
}

func TestHygieneTLSExpiry(t *testing.T) {
	rep := evaluate(HygieneInput{TLSSecrets: []corev1.Secret{
		tlsSecret("apps", "expired", selfSigned(t, hygieneNow.Add(-24*time.Hour))),
		tlsSecret("apps", "five-days", selfSigned(t, hygieneNow.Add(5*24*time.Hour+time.Hour), "a.example.com", "b.example.com")),
		tlsSecret("apps", "twenty-days", selfSigned(t, hygieneNow.Add(20*24*time.Hour+time.Hour))),
		tlsSecret("apps", "fresh", selfSigned(t, hygieneNow.Add(60*24*time.Hour))),
		tlsSecret("apps", "garbage", []byte("not a cert")),
		tlsSecret("kube-system", "skipped", selfSigned(t, hygieneNow.Add(-24*time.Hour))),
	}})
	got := map[string]HygieneFinding{}
	for _, f := range findingsOf(rep, "tls.expiry") {
		got[f.Name] = f
	}
	if len(got) != 4 {
		t.Fatalf("tls.expiry = %+v, want expired, five-days, twenty-days, garbage", got)
	}
	if f := got["expired"]; f.Severity != HygieneCritical || !strings.HasPrefix(f.Message, "expired 2026-10-07") {
		t.Errorf("expired = %+v", f)
	}
	if f := got["five-days"]; f.Severity != HygieneCritical || !strings.Contains(f.Message, "(5 days) · a.example.com, b.example.com") {
		t.Errorf("five-days = %+v", f)
	}
	if f := got["five-days"]; f.MessageKey != "tlsExpires" || f.MessageArgs["days"] != "5" || f.MessageArgs["suffix"] != " · a.example.com, b.example.com" {
		t.Errorf("five-days sentence = %q %v", f.MessageKey, f.MessageArgs)
	}
	if f := got["expired"]; f.MessageKey != "tlsExpired" || f.MessageArgs["date"] != "2026-10-07" {
		t.Errorf("expired sentence = %q %v", f.MessageKey, f.MessageArgs)
	}
	if f := got["garbage"]; f.MessageKey != "tlsUnreadable" {
		t.Errorf("garbage sentence = %q", f.MessageKey)
	}
	everyFindingHasAKey(t, rep)
	if f := got["twenty-days"]; f.Severity != HygieneWarning || !strings.Contains(f.Message, "(20 days)") {
		t.Errorf("twenty-days = %+v", f)
	}
	if f := got["garbage"]; f.Severity != HygieneWarning {
		t.Errorf("garbage = %+v", f)
	}
	for _, f := range rep.Findings {
		if strings.Contains(f.Message, "unused") {
			t.Fatalf("a key byte leaked into the report: %+v", f)
		}
	}
}
