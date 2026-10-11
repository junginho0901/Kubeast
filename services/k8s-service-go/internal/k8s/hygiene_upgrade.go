package k8s

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	admissionv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Upgrade readiness: what breaks when the cluster moves to the next minor
// version (the target is the server's minor + 1). The checks read the same
// way the rest of the hygiene report does — as the signed-in user, nothing
// installed — and cover the things the Kubernetes deprecation guide, the
// release changelogs and the version skew policy say an upgrade trips over:
// Helm releases still rendering removed APIs, CRDs with unserved stored
// versions, clients still calling deprecated APIs (apiserver metric), fail-
// closed admission webhooks without a backend, PodDisruptionBudgets that stop
// a drain, kubelet skew, kube-proxy ipvs, gitRepo volumes, Service
// externalIPs, scheduling.k8s.io/v1alpha2 objects and cgroup v1 node images.

// removedAPI is one row of the deprecation guide
// (https://kubernetes.io/docs/reference/using-api/deprecation-guide/).
type removedAPI struct {
	GroupVersion string
	Kinds        []string
	RemovedIn    int // minor
	Replacement  string
}

var removedAPIs = []removedAPI{
	// v1.16
	{"extensions/v1beta1", []string{"NetworkPolicy"}, 16, "networking.k8s.io/v1"},
	{"extensions/v1beta1", []string{"DaemonSet", "Deployment", "ReplicaSet"}, 16, "apps/v1"},
	{"extensions/v1beta1", []string{"PodSecurityPolicy"}, 16, "policy/v1beta1"},
	{"apps/v1beta1", []string{"Deployment", "StatefulSet", "ReplicaSet"}, 16, "apps/v1"},
	{"apps/v1beta2", []string{"DaemonSet", "Deployment", "StatefulSet", "ReplicaSet"}, 16, "apps/v1"},
	// v1.22
	{"admissionregistration.k8s.io/v1beta1", []string{"MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"}, 22, "admissionregistration.k8s.io/v1"},
	{"apiextensions.k8s.io/v1beta1", []string{"CustomResourceDefinition"}, 22, "apiextensions.k8s.io/v1"},
	{"apiregistration.k8s.io/v1beta1", []string{"APIService"}, 22, "apiregistration.k8s.io/v1"},
	{"authentication.k8s.io/v1beta1", []string{"TokenReview"}, 22, "authentication.k8s.io/v1"},
	{"authorization.k8s.io/v1beta1", []string{"LocalSubjectAccessReview", "SelfSubjectAccessReview", "SubjectAccessReview", "SelfSubjectRulesReview"}, 22, "authorization.k8s.io/v1"},
	{"certificates.k8s.io/v1beta1", []string{"CertificateSigningRequest"}, 22, "certificates.k8s.io/v1"},
	{"coordination.k8s.io/v1beta1", []string{"Lease"}, 22, "coordination.k8s.io/v1"},
	{"extensions/v1beta1", []string{"Ingress"}, 22, "networking.k8s.io/v1"},
	{"networking.k8s.io/v1beta1", []string{"Ingress", "IngressClass"}, 22, "networking.k8s.io/v1"},
	{"rbac.authorization.k8s.io/v1beta1", []string{"ClusterRole", "ClusterRoleBinding", "Role", "RoleBinding"}, 22, "rbac.authorization.k8s.io/v1"},
	{"scheduling.k8s.io/v1beta1", []string{"PriorityClass"}, 22, "scheduling.k8s.io/v1"},
	{"storage.k8s.io/v1beta1", []string{"CSIDriver", "CSINode", "StorageClass", "VolumeAttachment"}, 22, "storage.k8s.io/v1"},
	// v1.25
	{"batch/v1beta1", []string{"CronJob"}, 25, "batch/v1"},
	{"discovery.k8s.io/v1beta1", []string{"EndpointSlice"}, 25, "discovery.k8s.io/v1"},
	{"events.k8s.io/v1beta1", []string{"Event"}, 25, "events.k8s.io/v1"},
	{"autoscaling/v2beta1", []string{"HorizontalPodAutoscaler"}, 25, "autoscaling/v2"},
	{"policy/v1beta1", []string{"PodDisruptionBudget"}, 25, "policy/v1"},
	{"policy/v1beta1", []string{"PodSecurityPolicy"}, 25, "Pod Security Admission"},
	{"node.k8s.io/v1beta1", []string{"RuntimeClass"}, 25, "node.k8s.io/v1"},
	// v1.26
	{"flowcontrol.apiserver.k8s.io/v1beta1", []string{"FlowSchema", "PriorityLevelConfiguration"}, 26, "flowcontrol.apiserver.k8s.io/v1"},
	{"autoscaling/v2beta2", []string{"HorizontalPodAutoscaler"}, 26, "autoscaling/v2"},
	// v1.27
	{"storage.k8s.io/v1beta1", []string{"CSIStorageCapacity"}, 27, "storage.k8s.io/v1"},
	// v1.29
	{"flowcontrol.apiserver.k8s.io/v1beta2", []string{"FlowSchema", "PriorityLevelConfiguration"}, 29, "flowcontrol.apiserver.k8s.io/v1"},
	// v1.32
	{"flowcontrol.apiserver.k8s.io/v1beta3", []string{"FlowSchema", "PriorityLevelConfiguration"}, 32, "flowcontrol.apiserver.k8s.io/v1"},
}

// removedAPIFor returns the guide row for apiVersion + kind, if any.
func removedAPIFor(apiVersion, kind string) (removedAPI, bool) {
	for _, r := range removedAPIs {
		if r.GroupVersion != apiVersion {
			continue
		}
		for _, k := range r.Kinds {
			if k == kind {
				return r, true
			}
		}
	}
	return removedAPI{}, false
}

// HelmManifest is one release's rendered manifest, as Helm stored it.
type HelmManifest struct {
	Namespace string
	Name      string
	Manifest  string
}

type manifestObject struct {
	APIVersion, Kind, Name string
}

// schedulingObject is a scheduling.k8s.io/v1alpha2 object the collector found.
type schedulingObject struct {
	Kind, Namespace, Name string
}

var (
	manifestDocSep = regexp.MustCompile(`(?m)^---\s*$`)
	manifestTop    = regexp.MustCompile(`^(apiVersion|kind|metadata):\s*(.*)$`)
	manifestName   = regexp.MustCompile(`^  name:\s*["']?([^"'\s]+)`)
)

// manifestObjects reads apiVersion, kind and metadata.name of every document
// in a multi-document manifest without a YAML parser: the three keys sit at
// the top level, so line scanning is enough and tolerant of odd documents.
func manifestObjects(manifest string) []manifestObject {
	var out []manifestObject
	for _, doc := range manifestDocSep.Split(manifest, -1) {
		var o manifestObject
		inMeta := false
		for _, line := range strings.Split(doc, "\n") {
			if m := manifestTop.FindStringSubmatch(line); m != nil {
				inMeta = m[1] == "metadata"
				v := strings.Trim(strings.TrimSpace(m[2]), `"'`)
				switch m[1] {
				case "apiVersion":
					o.APIVersion = v
				case "kind":
					o.Kind = v
				}
				continue
			}
			if len(line) > 0 && line[0] != ' ' && line[0] != '#' {
				inMeta = false
			}
			if inMeta && o.Name == "" {
				if m := manifestName.FindStringSubmatch(line); m != nil {
					o.Name = m[1]
				}
			}
		}
		if o.APIVersion != "" && o.Kind != "" {
			out = append(out, o)
		}
	}
	return out
}

// minorOf reads the minor from "v1.37.1", "1.37", "v1.36.2-eks-abc"; 0 when unreadable.
var versionRe = regexp.MustCompile(`v?(\d+)\.(\d+)`)

func minorOf(version string) int {
	m := versionRe.FindStringSubmatch(version)
	if m == nil || m[1] != "1" {
		return 0
	}
	n, _ := strconv.Atoi(m[2])
	return n
}

// deprecatedAPIMetric is one apiserver_requested_deprecated_apis series.
type deprecatedAPIMetric struct {
	Group, Version, Resource string
	RemovedIn                int
}

var (
	deprecatedAPILine  = regexp.MustCompile(`(?m)^apiserver_requested_deprecated_apis\{([^}]*)\}\s+([0-9.eE+-]+)`)
	deprecatedAPILabel = regexp.MustCompile(`(\w+)="([^"]*)"`)
)

// parseDeprecatedAPIs reads the apiserver's /metrics text for deprecated API
// use since it started (the gauge is 1 per group/version/resource requested).
func parseDeprecatedAPIs(metrics string) []deprecatedAPIMetric {
	var out []deprecatedAPIMetric
	for _, m := range deprecatedAPILine.FindAllStringSubmatch(metrics, -1) {
		if v, err := strconv.ParseFloat(m[2], 64); err != nil || v <= 0 {
			continue
		}
		var d deprecatedAPIMetric
		for _, l := range deprecatedAPILabel.FindAllStringSubmatch(m[1], -1) {
			switch l[1] {
			case "group":
				d.Group = l[2]
			case "version":
				d.Version = l[2]
			case "resource":
				d.Resource = l[2]
			case "removed_release":
				d.RemovedIn = minorOf(l[2])
			}
		}
		if d.Version != "" && d.Resource != "" {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Group+out[i].Version+out[i].Resource < out[j].Group+out[j].Version+out[j].Resource
	})
	return out
}

func groupVersionResource(d deprecatedAPIMetric) string {
	if d.Group == "" {
		return d.Version + "/" + d.Resource
	}
	return d.Group + "/" + d.Version + "/" + d.Resource
}

// crdUnservedStoredVersions returns the stored versions a CRD no longer serves.
func crdUnservedStoredVersions(crd unstructured.Unstructured) []string {
	served := map[string]bool{}
	versions, _, _ := unstructured.NestedSlice(crd.Object, "spec", "versions")
	for _, v := range versions {
		m, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if s, ok := m["served"].(bool); ok && s {
			served[name] = true
		}
	}
	stored, _, _ := unstructured.NestedStringSlice(crd.Object, "status", "storedVersions")
	var out []string
	for _, v := range stored {
		if !served[v] {
			out = append(out, v)
		}
	}
	return out
}

// webhookEntry is the part of a validating or mutating webhook the check reads.
type webhookEntry struct {
	Config, Name string
	Kind         string // ValidatingWebhookConfiguration | MutatingWebhookConfiguration
	FailClosed   bool
	Service      *admissionv1.ServiceReference
	HasCABundle  bool
	CatchAll     bool
	HasSelector  bool
	Annotations  map[string]string
}

func validatingEntries(cfgs []admissionv1.ValidatingWebhookConfiguration) []webhookEntry {
	var out []webhookEntry
	for _, c := range cfgs {
		for _, w := range c.Webhooks {
			out = append(out, webhookEntry{
				Config: c.Name, Name: w.Name, Kind: "ValidatingWebhookConfiguration",
				FailClosed:  w.FailurePolicy != nil && *w.FailurePolicy == admissionv1.Fail,
				Service:     w.ClientConfig.Service,
				HasCABundle: len(w.ClientConfig.CABundle) > 0,
				CatchAll:    rulesCatchAll(w.Rules),
				HasSelector: selectorSet(w.NamespaceSelector) || selectorSet(w.ObjectSelector),
				Annotations: c.Annotations,
			})
		}
	}
	return out
}

func mutatingEntries(cfgs []admissionv1.MutatingWebhookConfiguration) []webhookEntry {
	var out []webhookEntry
	for _, c := range cfgs {
		for _, w := range c.Webhooks {
			out = append(out, webhookEntry{
				Config: c.Name, Name: w.Name, Kind: "MutatingWebhookConfiguration",
				FailClosed:  w.FailurePolicy != nil && *w.FailurePolicy == admissionv1.Fail,
				Service:     w.ClientConfig.Service,
				HasCABundle: len(w.ClientConfig.CABundle) > 0,
				CatchAll:    rulesCatchAll(w.Rules),
				HasSelector: selectorSet(w.NamespaceSelector) || selectorSet(w.ObjectSelector),
				Annotations: c.Annotations,
			})
		}
	}
	return out
}

func rulesCatchAll(rules []admissionv1.RuleWithOperations) bool {
	for _, r := range rules {
		if contains(r.APIGroups, "*") && (contains(r.Resources, "*") || contains(r.Resources, "*/*")) {
			return true
		}
	}
	return false
}

func selectorSet(s *metav1.LabelSelector) bool {
	return s != nil && (len(s.MatchLabels) > 0 || len(s.MatchExpressions) > 0)
}

// readyEndpoints counts the ready addresses the slices of a Service hold.
func readyEndpoints(slices []discoveryv1.EndpointSlice, namespace, service string) int {
	n := 0
	for _, s := range slices {
		if s.Namespace != namespace || s.Labels[discoveryv1.LabelServiceName] != service {
			continue
		}
		for _, e := range s.Endpoints {
			if (e.Conditions.Ready == nil || *e.Conditions.Ready) && len(e.Addresses) > 0 {
				n++
			}
		}
	}
	return n
}

var cgroupV1OSImage = regexp.MustCompile(`(?i)^Amazon Linux 2(\s|$)|Ubuntu (16|18|20)\.04|CentOS Linux 7|Red Hat Enterprise Linux( Server)? [78]\.`)

var kubeProxyIPVS = regexp.MustCompile(`(?m)^\s*mode:\s*["']?ipvs["']?\s*$`)

// upgradeFindings adds the upgrade checks for target (a minor, 0 = unknown so
// nothing runs). Pod-level checks run in the pod loop (podUpgradeFindings).
func upgradeFindings(in HygieneInput, target int, excluded map[string]bool, nsAnnotations map[string]map[string]string, b *hygieneBuilder) {
	if target == 0 {
		return
	}
	applies := func(id string) bool { return hygieneCheckApplies(id, target) }
	server := minorOf(in.ServerVersion)

	if applies("upgrade.removed-api.helm") && !in.Failed["helm"] {
		for _, rel := range in.HelmManifests {
			if excluded[rel.Namespace] {
				continue
			}
			for _, o := range manifestObjects(rel.Manifest) {
				r, found := removedAPIFor(o.APIVersion, o.Kind)
				if !found || r.RemovedIn > target {
					continue
				}
				removed := "v1." + strconv.Itoa(r.RemovedIn)
				b.add(HygieneFinding{Check: "upgrade.removed-api.helm", Kind: o.Kind, Namespace: rel.Namespace, Name: rel.Name + "/" + o.Name,
					Message:    fmt.Sprintf("Helm release %s renders %s %s as %s, removed in %s (use %s): the next helm upgrade fails", rel.Name, o.Kind, o.Name, o.APIVersion, removed, r.Replacement),
					MessageKey: "helmRemovedAPI", MessageArgs: msgArgs("release", rel.Name, "kind", o.Kind, "object", o.Name, "apiVersion", o.APIVersion, "removed", removed, "replacement", r.Replacement)},
					parseExemption(nsAnnotations[rel.Namespace]))
			}
		}
	}

	if applies("upgrade.removed-api.crd") && !in.Failed["customresourcedefinitions"] {
		for _, crd := range in.CRDs {
			unserved := crdUnservedStoredVersions(crd)
			if len(unserved) == 0 {
				continue
			}
			list := strings.Join(unserved, ", ")
			b.add(HygieneFinding{Check: "upgrade.removed-api.crd", Kind: "CustomResourceDefinition", Name: crd.GetName(),
				Message:    "stored version " + list + " is no longer served: migrate the stored objects before the version is dropped",
				MessageKey: "crdStoredVersion", MessageArgs: msgArgs("versions", list)}, parseExemption(crd.GetAnnotations()))
		}
	}

	if applies("upgrade.deprecated-api.requests") && !in.Failed["metrics"] {
		for _, d := range parseDeprecatedAPIs(in.Metrics) {
			f := HygieneFinding{Check: "upgrade.deprecated-api.requests", Kind: "API", Name: groupVersionResource(d)}
			if d.RemovedIn > 0 && d.RemovedIn <= target {
				f.Severity = HygieneCritical
				f.Message = fmt.Sprintf("clients still request %s, removed in v1.%d: they break after the upgrade", f.Name, d.RemovedIn)
				f.MessageKey, f.MessageArgs = "deprecatedAPIRemoved", msgArgs("api", f.Name, "removed", "v1."+strconv.Itoa(d.RemovedIn))
			} else {
				removed := "a later release"
				if d.RemovedIn > 0 {
					removed = "v1." + strconv.Itoa(d.RemovedIn)
				}
				f.Message = fmt.Sprintf("clients still request deprecated %s (removed in %s)", f.Name, removed)
				f.MessageKey, f.MessageArgs = "deprecatedAPIRequested", msgArgs("api", f.Name, "removed", removed)
			}
			b.add(f, hygieneExemption{})
		}
	}

	if applies("upgrade.webhook.fail-closed") {
		var entries []webhookEntry
		if !in.Failed["validatingwebhookconfigurations"] {
			entries = append(entries, validatingEntries(in.Validating)...)
		}
		if !in.Failed["mutatingwebhookconfigurations"] {
			entries = append(entries, mutatingEntries(in.Mutating)...)
		}
		services := map[string]bool{}
		for _, s := range in.Services {
			services[s.Namespace+"/"+s.Name] = true
		}
		for _, e := range entries {
			if !e.FailClosed {
				continue
			}
			f := HygieneFinding{Check: "upgrade.webhook.fail-closed", Kind: e.Kind, Name: e.Config + "/" + e.Name}
			switch {
			case e.Service != nil && !in.Failed["services"] && !services[e.Service.Namespace+"/"+e.Service.Name]:
				f.Severity = HygieneCritical
				f.Message = fmt.Sprintf("fail-closed webhook with no backend: Service %s/%s does not exist — API writes it matches are refused", e.Service.Namespace, e.Service.Name)
				f.MessageKey, f.MessageArgs = "webhookNoService", msgArgs("service", e.Service.Namespace+"/"+e.Service.Name)
			case e.Service != nil && !in.Failed["endpointslices"] && readyEndpoints(in.EndpointSlices, e.Service.Namespace, e.Service.Name) == 0:
				f.Severity = HygieneCritical
				f.Message = fmt.Sprintf("fail-closed webhook with no ready endpoint behind Service %s/%s — API writes it matches are refused", e.Service.Namespace, e.Service.Name)
				f.MessageKey, f.MessageArgs = "webhookNoEndpoints", msgArgs("service", e.Service.Namespace+"/"+e.Service.Name)
			case e.CatchAll && !e.HasSelector:
				f.Message = "fail-closed webhook matching every resource: an outage of its backend stops all API writes during the upgrade"
				f.MessageKey = "webhookCatchAll"
			case e.Service != nil && !e.HasCABundle:
				f.Message = "fail-closed webhook without a caBundle: the API server cannot trust its backend"
				f.MessageKey = "webhookNoCA"
			default:
				continue
			}
			b.add(f, parseExemption(e.Annotations))
		}
	}

	if applies("upgrade.pdb.blocks-drain") && !in.Failed["poddisruptionbudgets"] {
		for _, pdb := range in.PDBs {
			if excluded[pdb.Namespace] || pdb.Status.DisruptionsAllowed != 0 || pdb.Status.ExpectedPods == 0 {
				continue
			}
			expected, healthy := strconv.Itoa(int(pdb.Status.ExpectedPods)), strconv.Itoa(int(pdb.Status.CurrentHealthy))
			b.add(HygieneFinding{Check: "upgrade.pdb.blocks-drain", Kind: "PodDisruptionBudget", Namespace: pdb.Namespace, Name: pdb.Name,
				Message:    fmt.Sprintf("allows 0 disruptions (%s pods, %s healthy): a node drain waits on it", expected, healthy),
				MessageKey: "pdbBlocksDrain", MessageArgs: msgArgs("expected", expected, "healthy", healthy)},
				parseExemption(pdb.Annotations))
		}
	}

	if applies("upgrade.node.skew") && !in.Failed["nodes"] && server > 0 {
		for _, n := range in.Nodes {
			kubelet := minorOf(n.Status.NodeInfo.KubeletVersion)
			if kubelet == 0 {
				continue
			}
			f := HygieneFinding{Check: "upgrade.node.skew", Kind: "Node", Name: n.Name}
			switch {
			case kubelet > server:
				f.Severity = HygieneCritical
				f.Message = fmt.Sprintf("kubelet %s is newer than the API server %s (never supported)", n.Status.NodeInfo.KubeletVersion, in.ServerVersion)
				f.MessageKey, f.MessageArgs = "nodeKubeletNewer", msgArgs("kubelet", n.Status.NodeInfo.KubeletVersion, "server", in.ServerVersion)
			case target-kubelet > 3:
				f.Message = fmt.Sprintf("kubelet %s would be more than three minors behind v1.%d: upgrade the node before the control plane", n.Status.NodeInfo.KubeletVersion, target)
				f.MessageKey, f.MessageArgs = "nodeKubeletBehind", msgArgs("kubelet", n.Status.NodeInfo.KubeletVersion, "target", "v1."+strconv.Itoa(target))
			default:
				continue
			}
			b.add(f, parseExemption(n.Annotations))
		}
	}

	if applies("upgrade.kube-proxy.ipvs") && !in.Failed["kube-proxy"] {
		names := make([]string, 0, len(in.KubeProxyConfig))
		for name := range in.KubeProxyConfig {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if kubeProxyIPVS.MatchString(in.KubeProxyConfig[name]) {
				b.add(HygieneFinding{Check: "upgrade.kube-proxy.ipvs", Kind: "ConfigMap", Namespace: "kube-system", Name: name,
					Message:    "kube-proxy runs in ipvs mode, deprecated since v1.35: move to nftables (or iptables) before it is removed",
					MessageKey: "kubeProxyIPVS"}, hygieneExemption{})
			}
		}
	}

	if applies("upgrade.service.external-ips") && !in.Failed["services"] {
		for _, s := range in.Services {
			if excluded[s.Namespace] || len(s.Spec.ExternalIPs) == 0 {
				continue
			}
			ips := strings.Join(s.Spec.ExternalIPs, ", ")
			b.add(HygieneFinding{Check: "upgrade.service.external-ips", Kind: "Service", Namespace: s.Namespace, Name: s.Name,
				Message:    "uses spec.externalIPs (" + ips + "), deprecated in v1.36: prefer a LoadBalancer or Ingress",
				MessageKey: "serviceExternalIPs", MessageArgs: msgArgs("ips", ips)},
				mergeExemptions(parseExemption(s.Annotations), parseExemption(nsAnnotations[s.Namespace]))[0])
		}
	}

	if applies("upgrade.scheduling.v1alpha2") && !in.Failed["scheduling.k8s.io/v1alpha2"] {
		for _, o := range in.SchedulingAlpha {
			b.add(HygieneFinding{Check: "upgrade.scheduling.v1alpha2", Kind: o.Kind, Namespace: o.Namespace, Name: o.Name,
				Message:    "scheduling.k8s.io/v1alpha2 object: v1.37 drops the version — delete or recreate it as v1alpha3/v1beta1 before upgrading",
				MessageKey: "schedulingV1alpha2"}, hygieneExemption{})
		}
	}

	if applies("upgrade.node.cgroup-v1") && !in.Failed["nodes"] {
		for _, n := range in.Nodes {
			os := n.Status.NodeInfo.OSImage
			if !cgroupV1OSImage.MatchString(os) {
				continue
			}
			b.add(HygieneFinding{Check: "upgrade.node.cgroup-v1", Kind: "Node", Name: n.Name,
				Message:    "OS image " + os + " usually runs cgroup v1, which a v1.35+ kubelet refuses to start on by default (failCgroupV1): check with `stat -fc %T /sys/fs/cgroup/` on the node",
				MessageKey: "nodeCgroupV1", MessageArgs: msgArgs("os", os)}, parseExemption(n.Annotations))
		}
	}
}

// podUpgradeFindings are the per-pod upgrade checks (run in the pod loop so
// pods of one owner group into one finding and the pod's exemptions apply).
func podUpgradeFindings(p corev1.Pod, target int) []HygieneFinding {
	if target == 0 || !hygieneCheckApplies("upgrade.pod.git-repo", target) {
		return nil
	}
	var out []HygieneFinding
	for _, v := range p.Spec.Volumes {
		if v.GitRepo != nil {
			out = append(out, HygieneFinding{Check: "upgrade.pod.git-repo", Container: "",
				Message:    "volume " + v.Name + " is a gitRepo volume, disabled by default in v1.36: clone in an init container instead",
				MessageKey: "gitRepoVolume", MessageArgs: msgArgs("volume", v.Name)})
		}
	}
	return out
}
