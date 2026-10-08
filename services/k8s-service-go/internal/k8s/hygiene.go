package k8s

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Cluster hygiene report: configuration risks read from the API as the
// signed-in user — Pod Security Standards (Kubernetes v1.37 tables), image
// tags, resources, namespace policy, service account tokens, RBAC and TLS
// certificate expiry. Pods of one owner are grouped into one finding per check.

const (
	HygieneCritical = "critical"
	HygieneWarning  = "warning"
	HygieneInfo     = "info"

	HygieneExemptAnnotation       = "kubeast.io/hygiene-exempt"
	HygieneExemptReasonAnnotation = "kubeast.io/hygiene-exempt-reason"

	hygieneMaxFindings = 5000
)

type HygieneCheck struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Refs     string `json:"refs"`
}

// HygieneChecks is the report's check list, in display order.
var HygieneChecks = []HygieneCheck{
	{"pss.privileged", HygieneCritical, "PSS baseline · CIS 5.2.2 · EKS 4.2.1"},
	{"pss.host-namespaces", HygieneCritical, "PSS baseline · CIS 5.2.3-5.2.5 · EKS 4.2.2-4.2.4"},
	{"pss.hostpath", HygieneWarning, "PSS baseline · CIS 5.2.11"},
	{"pss.host-ports", HygieneWarning, "PSS baseline · CIS 5.2.12"},
	{"pss.capabilities", HygieneWarning, "PSS baseline · CIS 5.2.8-5.2.9"},
	{"pss.other-baseline", HygieneWarning, "PSS baseline · CIS 5.2.10"},
	{"pss.restricted", HygieneInfo, "PSS restricted · CIS 5.2.6-5.2.7 · EKS 4.2.5"},
	{"image.latest", HygieneWarning, "Kubernetes Images (avoid :latest)"},
	{"resources.memory-limit", HygieneWarning, "Kubernetes security checklist"},
	{"resources.requests", HygieneInfo, "Kubernetes security checklist"},
	{"ns.pss-label", HygieneWarning, "Kubernetes security checklist · CIS 5.2.1"},
	{"ns.network-policy", HygieneWarning, "CIS 5.3.2 · EKS 4.3.2"},
	{"ns.default-used", HygieneInfo, "CIS 5.6.4 · EKS 4.5.2"},
	{"sa.default-token", HygieneInfo, "CIS 5.1.5-5.1.6 · EKS 4.1.5-4.1.6"},
	{"rbac.cluster-admin", HygieneWarning, "CIS 5.1.1 · EKS 4.1.1"},
	{"rbac.wildcard", HygieneWarning, "CIS 5.1.3 · EKS 4.1.3"},
	{"tls.expiry", HygieneWarning, "Kubernetes security checklist · cert-manager renews at 2/3"},
}

type HygieneFinding struct {
	Check        string `json:"check"`
	Severity     string `json:"severity"`
	Kind         string `json:"kind"`
	Namespace    string `json:"namespace,omitempty"`
	Name         string `json:"name"`
	Container    string `json:"container,omitempty"`
	Pods         int    `json:"pods,omitempty"`
	Message      string `json:"message"`
	Exempt       bool   `json:"exempt,omitempty"`
	ExemptReason string `json:"exempt_reason,omitempty"`
}

type HygieneCheckSummary struct {
	HygieneCheck
	Findings int `json:"findings"`
	Exempt   int `json:"exempt"`
}

// HygieneCollector is a list the report could not read (its checks are skipped).
type HygieneCollector struct {
	What  string `json:"what"`
	Error string `json:"error"`
}

type HygieneCounts struct {
	Critical int `json:"critical"`
	Warning  int `json:"warning"`
	Info     int `json:"info"`
	Exempt   int `json:"exempt"`
}

type HygieneReport struct {
	GeneratedAt        string                `json:"generated_at"`
	ExcludedNamespaces []string              `json:"excluded_namespaces"`
	Counts             HygieneCounts         `json:"counts"`
	Checks             []HygieneCheckSummary `json:"checks"`
	Findings           []HygieneFinding      `json:"findings"`
	Collectors         []HygieneCollector    `json:"collectors"`
	Truncated          bool                  `json:"truncated,omitempty"`
}

type HygieneOptions struct {
	ExcludeNamespaces []string
	TLSWarnDays       int
	TLSCriticalDays   int
	Now               time.Time
}

// HygieneInput is what the checks read. Failed names the lists that could not
// be read; checks that need them are skipped instead of reporting false gaps.
type HygieneInput struct {
	Pods                []corev1.Pod
	Namespaces          []corev1.Namespace
	NetworkPolicies     []networkingv1.NetworkPolicy
	ClusterRoleBindings []rbacv1.ClusterRoleBinding
	RoleBindings        []rbacv1.RoleBinding
	ClusterRoles        []rbacv1.ClusterRole
	Roles               []rbacv1.Role
	TLSSecrets          []corev1.Secret
	Collectors          []HygieneCollector
	Failed              map[string]bool
}

// CollectHygiene lists what the checks need, as the caller, and evaluates it.
func (s *Service) CollectHygiene(ctx context.Context, opts HygieneOptions) (HygieneReport, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return HygieneReport{}, errNotLoaded
	}
	in := HygieneInput{Failed: map[string]bool{}}
	ok := func(what string, err error) bool {
		if err != nil {
			in.Failed[what] = true
			in.Collectors = append(in.Collectors, HygieneCollector{What: what, Error: err.Error()})
			return false
		}
		return true
	}
	all := metav1.ListOptions{}
	if l, err := cs.CoreV1().Pods("").List(ctx, all); ok("pods", err) {
		in.Pods = l.Items
	}
	if l, err := cs.CoreV1().Namespaces().List(ctx, all); ok("namespaces", err) {
		in.Namespaces = l.Items
	}
	if l, err := cs.NetworkingV1().NetworkPolicies("").List(ctx, all); ok("networkpolicies", err) {
		in.NetworkPolicies = l.Items
	}
	if l, err := cs.RbacV1().ClusterRoleBindings().List(ctx, all); ok("clusterrolebindings", err) {
		in.ClusterRoleBindings = l.Items
	}
	if l, err := cs.RbacV1().RoleBindings("").List(ctx, all); ok("rolebindings", err) {
		in.RoleBindings = l.Items
	}
	if l, err := cs.RbacV1().ClusterRoles().List(ctx, all); ok("clusterroles", err) {
		in.ClusterRoles = l.Items
	}
	if l, err := cs.RbacV1().Roles("").List(ctx, all); ok("roles", err) {
		in.Roles = l.Items
	}
	if l, err := cs.CoreV1().Secrets("").List(ctx, metav1.ListOptions{FieldSelector: "type=" + string(corev1.SecretTypeTLS)}); ok("secrets", err) {
		in.TLSSecrets = l.Items
	}
	return EvaluateHygiene(in, opts), nil
}

// EvaluateHygiene runs every check over the input.
func EvaluateHygiene(in HygieneInput, opts HygieneOptions) HygieneReport {
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	excluded := map[string]bool{}
	for _, ns := range opts.ExcludeNamespaces {
		excluded[ns] = true
	}
	nsAnnotations := map[string]map[string]string{}
	for _, n := range in.Namespaces {
		nsAnnotations[n.Name] = n.Annotations
	}
	b := &hygieneBuilder{index: map[string]int{}}

	podsPerNS := map[string]int{}
	if !in.Failed["pods"] {
		for _, p := range in.Pods {
			if excluded[p.Namespace] {
				continue
			}
			podsPerNS[p.Namespace]++
			kind, name := podOwner(p)
			ex := mergeExemptions(parseExemption(p.Annotations), parseExemption(nsAnnotations[p.Namespace]))
			for _, f := range podHygieneFindings(p) {
				f.Kind, f.Namespace, f.Name = kind, p.Namespace, name
				b.addPod(f, ex)
			}
		}
	}

	if !in.Failed["namespaces"] {
		withPolicy := map[string]bool{}
		for _, np := range in.NetworkPolicies {
			withPolicy[np.Namespace] = true
		}
		for _, n := range in.Namespaces {
			if excluded[n.Name] {
				continue
			}
			ex := parseExemption(n.Annotations)
			if n.Labels["pod-security.kubernetes.io/enforce"] == "" {
				msg := "no pod-security.kubernetes.io/enforce label"
				if w := n.Labels["pod-security.kubernetes.io/warn"]; w != "" {
					msg += " (warn=" + w + ")"
				}
				b.add(HygieneFinding{Check: "ns.pss-label", Kind: "Namespace", Name: n.Name, Message: msg}, ex)
			}
			if !in.Failed["networkpolicies"] && !withPolicy[n.Name] {
				b.add(HygieneFinding{Check: "ns.network-policy", Kind: "Namespace", Name: n.Name,
					Message: fmt.Sprintf("no NetworkPolicy (%d pods)", podsPerNS[n.Name])}, ex)
			}
		}
	}

	for _, crb := range in.ClusterRoleBindings {
		if crb.RoleRef.Kind == "ClusterRole" && crb.RoleRef.Name == "cluster-admin" && !builtinClusterAdminBinding(crb.Name) {
			b.add(HygieneFinding{Check: "rbac.cluster-admin", Kind: "ClusterRoleBinding", Name: crb.Name,
				Message: "binds cluster-admin to " + subjectList(crb.Subjects)}, parseExemption(crb.Annotations))
		}
	}
	for _, rb := range in.RoleBindings {
		if excluded[rb.Namespace] {
			continue
		}
		if rb.RoleRef.Kind == "ClusterRole" && rb.RoleRef.Name == "cluster-admin" {
			b.add(HygieneFinding{Check: "rbac.cluster-admin", Kind: "RoleBinding", Namespace: rb.Namespace, Name: rb.Name,
				Message: "binds cluster-admin in the namespace to " + subjectList(rb.Subjects)}, parseExemption(rb.Annotations))
		}
	}
	for _, cr := range in.ClusterRoles {
		if cr.AggregationRule != nil || builtinClusterRole(cr.Name) {
			continue
		}
		if msg := wildcardRule(cr.Rules); msg != "" {
			b.add(HygieneFinding{Check: "rbac.wildcard", Kind: "ClusterRole", Name: cr.Name, Message: msg}, parseExemption(cr.Annotations))
		}
	}
	for _, r := range in.Roles {
		if excluded[r.Namespace] {
			continue
		}
		if msg := wildcardRule(r.Rules); msg != "" {
			b.add(HygieneFinding{Check: "rbac.wildcard", Kind: "Role", Namespace: r.Namespace, Name: r.Name, Message: msg}, parseExemption(r.Annotations))
		}
	}

	warn, crit := opts.TLSWarnDays, opts.TLSCriticalDays
	if crit < 0 {
		crit = 0
	}
	if warn < crit {
		warn = crit
	}
	for _, s := range in.TLSSecrets {
		if excluded[s.Namespace] {
			continue
		}
		if f, found := tlsFinding(s, now, warn, crit); found {
			b.add(f, parseExemption(s.Annotations))
		}
	}

	return b.report(now, opts.ExcludeNamespaces, in.Collectors)
}

// --- pods ---------------------------------------------------------------

type hygieneContainer struct {
	name      string
	app       bool // spec.containers (not init/ephemeral)
	image     string
	sc        *corev1.SecurityContext
	ports     []corev1.ContainerPort
	resources corev1.ResourceRequirements
	probes    []*corev1.Probe
	lifecycle *corev1.Lifecycle
}

func podContainers(p corev1.Pod) []hygieneContainer {
	var out []hygieneContainer
	for _, c := range p.Spec.Containers {
		out = append(out, hygieneContainer{c.Name, true, c.Image, c.SecurityContext, c.Ports, c.Resources,
			[]*corev1.Probe{c.LivenessProbe, c.ReadinessProbe, c.StartupProbe}, c.Lifecycle})
	}
	for _, c := range p.Spec.InitContainers {
		out = append(out, hygieneContainer{c.Name, false, c.Image, c.SecurityContext, c.Ports, c.Resources,
			[]*corev1.Probe{c.LivenessProbe, c.ReadinessProbe, c.StartupProbe}, c.Lifecycle})
	}
	for _, c := range p.Spec.EphemeralContainers {
		out = append(out, hygieneContainer{c.Name, false, c.Image, c.SecurityContext, c.Ports, c.Resources, nil, nil})
	}
	return out
}

var (
	baselineCapabilities = setOf("AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD",
		"NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT")
	baselineSELinuxTypes = setOf("", "container_t", "container_init_t", "container_kvm_t", "container_engine_t")
	baselineSysctls      = setOf("kernel.shm_rmid_forced", "net.ipv4.ip_local_port_range", "net.ipv4.ip_unprivileged_port_start",
		"net.ipv4.tcp_syncookies", "net.ipv4.ping_group_range", "net.ipv4.ip_local_reserved_ports", "net.ipv4.tcp_keepalive_time",
		"net.ipv4.tcp_fin_timeout", "net.ipv4.tcp_keepalive_intvl", "net.ipv4.tcp_keepalive_probes")
)

// podHygieneFindings returns the pod's findings without owner fields.
func podHygieneFindings(p corev1.Pod) []HygieneFinding {
	var out []HygieneFinding
	add := func(check, container, msg string) {
		out = append(out, HygieneFinding{Check: check, Container: container, Message: msg})
	}
	spec := p.Spec
	psc := spec.SecurityContext
	if psc == nil {
		psc = &corev1.PodSecurityContext{}
	}
	containers := podContainers(p)

	var privileged, hostPorts, caps, other []string
	for _, c := range containers {
		sc := c.sc
		if sc == nil {
			sc = &corev1.SecurityContext{}
		}
		if sc.Privileged != nil && *sc.Privileged {
			privileged = append(privileged, c.name)
		}
		for _, port := range c.ports {
			if port.HostPort != 0 {
				hostPorts = append(hostPorts, fmt.Sprintf("%d (%s)", port.HostPort, c.name))
			}
		}
		if sc.Capabilities != nil {
			var extra []string
			for _, cp := range sc.Capabilities.Add {
				if !baselineCapabilities[string(cp)] {
					extra = append(extra, string(cp))
				}
			}
			if len(extra) > 0 {
				caps = append(caps, c.name+" adds "+strings.Join(extra, ", "))
			}
		}
		if sc.WindowsOptions != nil && sc.WindowsOptions.HostProcess != nil && *sc.WindowsOptions.HostProcess {
			other = append(other, "hostProcess ("+c.name+")")
		}
		if probeHost(c.probes, c.lifecycle) {
			other = append(other, "probe or lifecycle host ("+c.name+")")
		}
		if sc.AppArmorProfile != nil && sc.AppArmorProfile.Type == corev1.AppArmorProfileTypeUnconfined {
			other = append(other, "AppArmor Unconfined ("+c.name+")")
		}
		if bad := seLinuxViolation(sc.SELinuxOptions); bad != "" {
			other = append(other, bad+" ("+c.name+")")
		}
		if sc.ProcMount != nil && *sc.ProcMount != corev1.DefaultProcMount {
			other = append(other, "procMount "+string(*sc.ProcMount)+" ("+c.name+")")
		}
		if sc.SeccompProfile != nil && sc.SeccompProfile.Type == corev1.SeccompProfileTypeUnconfined {
			other = append(other, "seccomp Unconfined ("+c.name+")")
		}
		if c.app {
			if img := c.image; imageLatest(img) {
				add("image.latest", c.name, "image "+img)
			}
			if _, set := c.resources.Limits[corev1.ResourceMemory]; !set {
				add("resources.memory-limit", c.name, "no memory limit")
			}
			var missing []string
			if _, set := c.resources.Requests[corev1.ResourceCPU]; !set {
				missing = append(missing, "cpu")
			}
			if _, set := c.resources.Requests[corev1.ResourceMemory]; !set {
				missing = append(missing, "memory")
			}
			if len(missing) > 0 {
				add("resources.requests", c.name, "no "+strings.Join(missing, "/")+" request")
			}
		} else if imageLatest(c.image) {
			add("image.latest", c.name, "image "+c.image)
		}
	}
	if psc.WindowsOptions != nil && psc.WindowsOptions.HostProcess != nil && *psc.WindowsOptions.HostProcess {
		other = append(other, "hostProcess (pod)")
	}
	if psc.AppArmorProfile != nil && psc.AppArmorProfile.Type == corev1.AppArmorProfileTypeUnconfined {
		other = append(other, "AppArmor Unconfined (pod)")
	}
	for k, v := range p.Annotations {
		if strings.HasPrefix(k, "container.apparmor.security.beta.kubernetes.io/") && v != "runtime/default" && !strings.HasPrefix(v, "localhost/") {
			other = append(other, "AppArmor annotation "+v+" ("+strings.TrimPrefix(k, "container.apparmor.security.beta.kubernetes.io/")+")")
		}
	}
	if bad := seLinuxViolation(psc.SELinuxOptions); bad != "" {
		other = append(other, bad+" (pod)")
	}
	if psc.SeccompProfile != nil && psc.SeccompProfile.Type == corev1.SeccompProfileTypeUnconfined {
		other = append(other, "seccomp Unconfined (pod)")
	}
	for _, s := range psc.Sysctls {
		if !baselineSysctls[s.Name] {
			other = append(other, "sysctl "+s.Name)
		}
	}

	if len(privileged) > 0 {
		add("pss.privileged", "", "privileged: "+strings.Join(privileged, ", "))
	}
	var hostNS []string
	if spec.HostNetwork {
		hostNS = append(hostNS, "hostNetwork")
	}
	if spec.HostPID {
		hostNS = append(hostNS, "hostPID")
	}
	if spec.HostIPC {
		hostNS = append(hostNS, "hostIPC")
	}
	if len(hostNS) > 0 {
		add("pss.host-namespaces", "", strings.Join(hostNS, ", "))
	}
	var hostPaths []string
	for _, v := range spec.Volumes {
		if v.HostPath != nil {
			hostPaths = append(hostPaths, v.HostPath.Path+" ("+v.Name+")")
		}
	}
	if len(hostPaths) > 0 {
		add("pss.hostpath", "", "hostPath: "+strings.Join(hostPaths, ", "))
	}
	if len(hostPorts) > 0 {
		add("pss.host-ports", "", "hostPort: "+strings.Join(hostPorts, ", "))
	}
	if len(caps) > 0 {
		add("pss.capabilities", "", strings.Join(caps, "; "))
	}
	if len(other) > 0 {
		sort.Strings(other)
		add("pss.other-baseline", "", strings.Join(other, "; "))
	}
	if r := restrictedGaps(p, containers, psc); len(r) > 0 {
		add("pss.restricted", "", "restricted: "+strings.Join(r, ", "))
	}
	if p.Namespace == "default" {
		add("ns.default-used", "", "runs in the default namespace")
	}
	if (spec.ServiceAccountName == "" || spec.ServiceAccountName == "default") && mountsServiceAccountToken(spec) {
		add("sa.default-token", "", "default ServiceAccount token mounted")
	}
	return out
}

// restrictedGaps lists the PSS restricted controls the pod does not meet.
func restrictedGaps(p corev1.Pod, containers []hygieneContainer, psc *corev1.PodSecurityContext) []string {
	linux := p.Spec.OS == nil || p.Spec.OS.Name != corev1.Windows
	var gaps []string
	for _, v := range p.Spec.Volumes {
		vs := v.VolumeSource
		if vs.ConfigMap == nil && vs.CSI == nil && vs.DownwardAPI == nil && vs.EmptyDir == nil && vs.Ephemeral == nil &&
			vs.PersistentVolumeClaim == nil && vs.Projected == nil && vs.Secret == nil {
			gaps = append(gaps, "volume types")
			break
		}
	}
	escalation, nonRoot, rootUser, seccomp, capsAll := false, false, psc.RunAsUser != nil && *psc.RunAsUser == 0, false, false
	podNonRoot := psc.RunAsNonRoot != nil && *psc.RunAsNonRoot
	podSeccomp := psc.SeccompProfile != nil && (psc.SeccompProfile.Type == corev1.SeccompProfileTypeRuntimeDefault || psc.SeccompProfile.Type == corev1.SeccompProfileTypeLocalhost)
	for _, c := range containers {
		sc := c.sc
		if sc == nil {
			sc = &corev1.SecurityContext{}
		}
		if linux && (sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation) {
			escalation = true
		}
		if sc.RunAsNonRoot != nil {
			if !*sc.RunAsNonRoot {
				nonRoot = true
			}
		} else if !podNonRoot {
			nonRoot = true
		}
		if sc.RunAsUser != nil && *sc.RunAsUser == 0 {
			rootUser = true
		}
		if linux {
			if sc.SeccompProfile != nil {
				if t := sc.SeccompProfile.Type; t != corev1.SeccompProfileTypeRuntimeDefault && t != corev1.SeccompProfileTypeLocalhost {
					seccomp = true
				}
			} else if !podSeccomp {
				seccomp = true
			}
			dropsAll := false
			if sc.Capabilities != nil {
				for _, d := range sc.Capabilities.Drop {
					if d == "ALL" {
						dropsAll = true
					}
				}
				for _, a := range sc.Capabilities.Add {
					if a != "NET_BIND_SERVICE" {
						dropsAll = false
					}
				}
			}
			if !dropsAll {
				capsAll = true
			}
		}
	}
	if escalation {
		gaps = append(gaps, "allowPrivilegeEscalation")
	}
	if nonRoot {
		gaps = append(gaps, "runAsNonRoot")
	}
	if rootUser {
		gaps = append(gaps, "runAsUser 0")
	}
	if seccomp {
		gaps = append(gaps, "seccomp")
	}
	if capsAll {
		gaps = append(gaps, "capabilities drop ALL")
	}
	return gaps
}

func probeHost(probes []*corev1.Probe, lc *corev1.Lifecycle) bool {
	for _, p := range probes {
		if p == nil {
			continue
		}
		if (p.HTTPGet != nil && p.HTTPGet.Host != "") || (p.TCPSocket != nil && p.TCPSocket.Host != "") {
			return true
		}
	}
	if lc != nil {
		for _, h := range []*corev1.LifecycleHandler{lc.PostStart, lc.PreStop} {
			if h != nil && ((h.HTTPGet != nil && h.HTTPGet.Host != "") || (h.TCPSocket != nil && h.TCPSocket.Host != "")) {
				return true
			}
		}
	}
	return false
}

func seLinuxViolation(o *corev1.SELinuxOptions) string {
	if o == nil {
		return ""
	}
	switch {
	case !baselineSELinuxTypes[o.Type]:
		return "SELinux type " + o.Type
	case o.User != "":
		return "SELinux user " + o.User
	case o.Role != "":
		return "SELinux role " + o.Role
	}
	return ""
}

// imageLatest reports an image with neither a digest nor a tag other than latest.
func imageLatest(image string) bool {
	if image == "" || strings.Contains(image, "@") {
		return false
	}
	last := image[strings.LastIndex(image, "/")+1:]
	i := strings.LastIndex(last, ":")
	return i < 0 || last[i+1:] == "latest"
}

func mountsServiceAccountToken(spec corev1.PodSpec) bool {
	for _, v := range spec.Volumes {
		if v.Projected == nil {
			continue
		}
		for _, src := range v.Projected.Sources {
			if src.ServiceAccountToken != nil {
				return true
			}
		}
	}
	return false
}

// podOwner names the workload a pod belongs to (a ReplicaSet's Deployment by
// its pod-template-hash; static pods stay pods).
func podOwner(p corev1.Pod) (string, string) {
	for _, o := range p.OwnerReferences {
		if o.Controller == nil || !*o.Controller {
			continue
		}
		switch o.Kind {
		case "Node":
			return "Pod", p.Name
		case "ReplicaSet":
			if h := p.Labels["pod-template-hash"]; h != "" && strings.HasSuffix(o.Name, "-"+h) {
				return "Deployment", strings.TrimSuffix(o.Name, "-"+h)
			}
		}
		return o.Kind, o.Name
	}
	return "Pod", p.Name
}

// --- RBAC and TLS ---------------------------------------------------------

func builtinClusterAdminBinding(name string) bool {
	return name == "cluster-admin" || name == "kubeadm:cluster-admins" || strings.HasPrefix(name, "system:") || strings.HasPrefix(name, "eks:")
}

func builtinClusterRole(name string) bool {
	switch name {
	case "cluster-admin", "admin", "edit", "view":
		return true
	}
	return strings.HasPrefix(name, "system:") || strings.HasPrefix(name, "eks:")
}

func wildcardRule(rules []rbacv1.PolicyRule) string {
	for _, r := range rules {
		if contains(r.Verbs, "*") || contains(r.Resources, "*") {
			return fmt.Sprintf("rule with verbs [%s] resources [%s]", strings.Join(r.Verbs, " "), strings.Join(r.Resources, " "))
		}
	}
	return ""
}

func subjectList(subjects []rbacv1.Subject) string {
	if len(subjects) == 0 {
		return "no subjects"
	}
	var out []string
	for _, s := range subjects {
		name := s.Name
		if s.Namespace != "" {
			name = s.Namespace + "/" + s.Name
		}
		out = append(out, s.Kind+":"+name)
	}
	return strings.Join(out, ", ")
}

func tlsFinding(s corev1.Secret, now time.Time, warnDays, critDays int) (HygieneFinding, bool) {
	f := HygieneFinding{Check: "tls.expiry", Kind: "Secret", Namespace: s.Namespace, Name: s.Name}
	block, _ := pem.Decode(s.Data[corev1.TLSCertKey])
	if block == nil {
		f.Severity, f.Message = HygieneWarning, "tls.crt is not a readable certificate"
		return f, true
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		f.Severity, f.Message = HygieneWarning, "tls.crt is not a readable certificate"
		return f, true
	}
	days := int(cert.NotAfter.Sub(now).Hours() / 24)
	switch {
	case cert.NotAfter.Before(now):
		f.Severity = HygieneCritical
		f.Message = "expired " + cert.NotAfter.UTC().Format("2006-01-02")
	case days <= critDays:
		f.Severity = HygieneCritical
		f.Message = fmt.Sprintf("expires %s (%d days)", cert.NotAfter.UTC().Format("2006-01-02"), days)
	case days <= warnDays:
		f.Severity = HygieneWarning
		f.Message = fmt.Sprintf("expires %s (%d days)", cert.NotAfter.UTC().Format("2006-01-02"), days)
	default:
		return f, false
	}
	subject := cert.Subject.CommonName
	if len(cert.DNSNames) > 0 {
		names := cert.DNSNames
		if len(names) > 3 {
			names = append(names[:3:3], "…")
		}
		subject = strings.Join(names, ", ")
	}
	if subject != "" {
		f.Message += " · " + subject
	}
	if s.Annotations["cert-manager.io/certificate-name"] != "" {
		f.Message += " · cert-manager"
	}
	return f, true
}

// --- exemptions and assembly ---------------------------------------------

type hygieneExemption struct {
	checks map[string]bool
	all    bool
	reason string
	set    bool
}

func parseExemption(ann map[string]string) hygieneExemption {
	v, ok := ann[HygieneExemptAnnotation]
	if !ok {
		return hygieneExemption{}
	}
	ex := hygieneExemption{checks: map[string]bool{}, reason: strings.TrimSpace(ann[HygieneExemptReasonAnnotation]), set: true}
	for _, c := range strings.Split(v, ",") {
		c = strings.TrimSpace(c)
		if c == "*" {
			ex.all = true
		} else if c != "" {
			ex.checks[c] = true
		}
	}
	return ex
}

func (e hygieneExemption) covers(check string) bool { return e.set && (e.all || e.checks[check]) }

// mergeExemptions: the object's own annotation wins; the namespace's applies otherwise.
func mergeExemptions(own, ns hygieneExemption) []hygieneExemption { return []hygieneExemption{own, ns} }

type hygieneBuilder struct {
	findings []HygieneFinding
	index    map[string]int
}

func (b *hygieneBuilder) add(f HygieneFinding, ex hygieneExemption) {
	b.addPod(f, []hygieneExemption{ex})
}

func (b *hygieneBuilder) addPod(f HygieneFinding, exs []hygieneExemption) {
	key := strings.Join([]string{f.Check, f.Kind, f.Namespace, f.Name, f.Container}, "|")
	if i, seen := b.index[key]; seen {
		if b.findings[i].Pods > 0 {
			b.findings[i].Pods++
		}
		return
	}
	if f.Severity == "" {
		f.Severity = checkSeverity(f.Check)
	}
	if f.Kind != "Namespace" && f.Kind != "Secret" && f.Kind != "ClusterRoleBinding" && f.Kind != "RoleBinding" && f.Kind != "ClusterRole" && f.Kind != "Role" {
		f.Pods = 1
	}
	for _, ex := range exs {
		if !ex.covers(f.Check) {
			continue
		}
		if ex.reason == "" {
			f.Message += " (" + HygieneExemptAnnotation + " without " + HygieneExemptReasonAnnotation + ")"
		} else {
			f.Exempt, f.ExemptReason = true, ex.reason
		}
		break
	}
	b.index[key] = len(b.findings)
	b.findings = append(b.findings, f)
}

func (b *hygieneBuilder) report(now time.Time, excluded []string, collectors []HygieneCollector) HygieneReport {
	order := map[string]int{}
	for i, c := range HygieneChecks {
		order[c.ID] = i
	}
	rank := map[string]int{HygieneCritical: 0, HygieneWarning: 1, HygieneInfo: 2}
	sort.SliceStable(b.findings, func(i, j int) bool {
		a, c := b.findings[i], b.findings[j]
		if a.Exempt != c.Exempt {
			return !a.Exempt
		}
		if rank[a.Severity] != rank[c.Severity] {
			return rank[a.Severity] < rank[c.Severity]
		}
		if order[a.Check] != order[c.Check] {
			return order[a.Check] < order[c.Check]
		}
		if a.Namespace != c.Namespace {
			return a.Namespace < c.Namespace
		}
		if a.Name != c.Name {
			return a.Name < c.Name
		}
		return a.Container < c.Container
	})
	rep := HygieneReport{
		GeneratedAt:        now.UTC().Format(time.RFC3339),
		ExcludedNamespaces: append([]string{}, excluded...),
		Collectors:         append([]HygieneCollector{}, collectors...),
		Findings:           []HygieneFinding{},
	}
	per := map[string]*HygieneCheckSummary{}
	for _, c := range HygieneChecks {
		s := HygieneCheckSummary{HygieneCheck: c}
		rep.Checks = append(rep.Checks, s)
	}
	for i := range rep.Checks {
		per[rep.Checks[i].ID] = &rep.Checks[i]
	}
	for _, f := range b.findings {
		if s := per[f.Check]; s != nil {
			if f.Exempt {
				s.Exempt++
			} else {
				s.Findings++
			}
		}
		switch {
		case f.Exempt:
			rep.Counts.Exempt++
		case f.Severity == HygieneCritical:
			rep.Counts.Critical++
		case f.Severity == HygieneWarning:
			rep.Counts.Warning++
		default:
			rep.Counts.Info++
		}
	}
	rep.Findings = b.findings
	if len(rep.Findings) > hygieneMaxFindings {
		rep.Findings, rep.Truncated = rep.Findings[:hygieneMaxFindings], true
	}
	return rep
}

func checkSeverity(id string) string {
	for _, c := range HygieneChecks {
		if c.ID == id {
			return c.Severity
		}
	}
	return HygieneInfo
}

func setOf(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, i := range items {
		m[i] = true
	}
	return m
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
