package k8s

import (
	"strings"
	"testing"

	admissionv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// The upgrade checks judge against the next minor: a v1.36 server targets v1.37.

func upgradeReport(t *testing.T, in HygieneInput) HygieneReport {
	t.Helper()
	if in.ServerVersion == "" {
		in.ServerVersion = "v1.36.2"
	}
	if in.Failed == nil {
		in.Failed = map[string]bool{}
	}
	return EvaluateHygiene(in, HygieneOptions{Now: hygieneNow})
}

func TestUpgrade_TargetAndApplies(t *testing.T) {
	rep := upgradeReport(t, HygieneInput{ServerVersion: "v1.35.4-eks-abc"})
	if rep.ServerVersion != "v1.35.4-eks-abc" || rep.TargetVersion != "v1.36" {
		t.Fatalf("versions = %q → %q", rep.ServerVersion, rep.TargetVersion)
	}
	applies := map[string]bool{}
	for _, c := range rep.Checks {
		applies[c.ID] = c.Applies
	}
	// v1.37-only checks do not run for a v1.36 target; the rest do.
	if applies["upgrade.scheduling.v1alpha2"] || !applies["upgrade.pod.git-repo"] || !applies["upgrade.node.skew"] || !applies["pss.privileged"] {
		t.Fatalf("applies = %v", applies)
	}
	if len(rep.Checks) != 28 {
		t.Fatalf("checks = %d", len(rep.Checks))
	}

	// No server version: no target, the upgrade checks are listed as not applying.
	rep = EvaluateHygiene(HygieneInput{Failed: map[string]bool{"serverversion": true}}, HygieneOptions{Now: hygieneNow})
	if rep.TargetVersion != "" {
		t.Fatalf("target without a server version: %q", rep.TargetVersion)
	}
	for _, c := range rep.Checks {
		if strings.HasPrefix(c.ID, "upgrade.") && c.Applies {
			t.Fatalf("%s applies without a target", c.ID)
		}
	}
}

func TestUpgrade_HelmRemovedAPI(t *testing.T) {
	manifest := strings.Join([]string{
		"---",
		"# Source: app/templates/cron.yaml",
		"apiVersion: batch/v1beta1",
		"kind: CronJob",
		"metadata:",
		"  name: nightly",
		"  namespace: apps",
		"spec: {}",
		"---",
		"apiVersion: apps/v1",
		"kind: Deployment",
		"metadata:",
		"  labels:",
		"    app: web",
		"  name: web",
		"---",
		"apiVersion: flowcontrol.apiserver.k8s.io/v1beta3",
		"kind: FlowSchema",
		"metadata:",
		"  name: fs",
	}, "\n")
	objs := manifestObjects(manifest)
	if len(objs) != 3 || objs[0].Name != "nightly" || objs[1].Name != "web" || objs[2].APIVersion != "flowcontrol.apiserver.k8s.io/v1beta3" {
		t.Fatalf("objects = %+v", objs)
	}

	in := HygieneInput{HelmManifests: []HelmManifest{{Namespace: "apps", Name: "app", Manifest: manifest}}}
	rep := upgradeReport(t, in)
	got := map[string]HygieneFinding{}
	for _, f := range findingsOf(rep, "upgrade.removed-api.helm") {
		got[f.Name] = f
	}
	if len(got) != 2 {
		t.Fatalf("findings = %+v", got)
	}
	cron := got["app/nightly"]
	if cron.Severity != HygieneCritical || cron.Namespace != "apps" || !strings.Contains(cron.Message, "batch/v1beta1, removed in v1.25 (use batch/v1)") {
		t.Fatalf("cronjob finding = %+v", cron)
	}
	if cron.MessageArgs["replacement"] != "batch/v1" || cron.MessageKey != "helmRemovedAPI" {
		t.Fatalf("args = %+v", cron.MessageArgs)
	}
	if fs := got["app/fs"]; !strings.Contains(fs.Message, "removed in v1.32") {
		t.Fatalf("flowschema finding = %+v", fs)
	}

	// A target below the removal is not a finding; an excluded namespace is skipped.
	rep = EvaluateHygiene(in, HygieneOptions{Now: hygieneNow, TargetMinor: 24})
	if len(findingsOf(rep, "upgrade.removed-api.helm")) != 0 {
		t.Fatal("v1.24 target must not flag batch/v1beta1")
	}
	rep = EvaluateHygiene(in, HygieneOptions{Now: hygieneNow, TargetMinor: 37, ExcludeNamespaces: []string{"apps"}})
	if len(findingsOf(rep, "upgrade.removed-api.helm")) != 0 {
		t.Fatal("excluded namespace must be skipped")
	}
	// The list could not be read: nothing, and no false "clean".
	rep = upgradeReport(t, HygieneInput{Failed: map[string]bool{"helm": true}, HelmManifests: in.HelmManifests})
	if len(findingsOf(rep, "upgrade.removed-api.helm")) != 0 {
		t.Fatal("failed collector must skip the check")
	}
}

func TestRemovedAPIFor(t *testing.T) {
	if r, ok := removedAPIFor("storage.k8s.io/v1beta1", "CSIStorageCapacity"); !ok || r.RemovedIn != 27 {
		t.Fatalf("CSIStorageCapacity = %+v %v", r, ok)
	}
	if r, ok := removedAPIFor("storage.k8s.io/v1beta1", "StorageClass"); !ok || r.RemovedIn != 22 {
		t.Fatalf("StorageClass = %+v %v", r, ok)
	}
	if _, ok := removedAPIFor("apps/v1", "Deployment"); ok {
		t.Fatal("apps/v1 is not removed")
	}
}

func TestUpgrade_CRDStoredVersions(t *testing.T) {
	crd := unstructured.Unstructured{Object: map[string]interface{}{
		"metadata": map[string]interface{}{"name": "widgets.example.com"},
		"spec": map[string]interface{}{"versions": []interface{}{
			map[string]interface{}{"name": "v1alpha1", "served": false},
			map[string]interface{}{"name": "v1", "served": true},
		}},
		"status": map[string]interface{}{"storedVersions": []interface{}{"v1alpha1", "v1"}},
	}}
	rep := upgradeReport(t, HygieneInput{CRDs: []unstructured.Unstructured{crd}})
	got := findingsOf(rep, "upgrade.removed-api.crd")
	if len(got) != 1 || got[0].Name != "widgets.example.com" || got[0].MessageArgs["versions"] != "v1alpha1" {
		t.Fatalf("findings = %+v", got)
	}
}

func TestUpgrade_DeprecatedAPIRequests(t *testing.T) {
	metrics := strings.Join([]string{
		"# HELP apiserver_requested_deprecated_apis [STABLE] Gauge of deprecated APIs that have been requested",
		`apiserver_requested_deprecated_apis{group="flowcontrol.apiserver.k8s.io",removed_release="1.32",resource="flowschemas",version="v1beta3"} 1`,
		`apiserver_requested_deprecated_apis{group="",removed_release="1.40",resource="componentstatuses",version="v1"} 1`,
		`apiserver_requested_deprecated_apis{group="x",removed_release="1.30",resource="zeros",version="v1"} 0`,
		"apiserver_request_total 12",
	}, "\n")
	parsed := parseDeprecatedAPIs(metrics)
	if len(parsed) != 2 {
		t.Fatalf("parsed = %+v", parsed)
	}
	rep := upgradeReport(t, HygieneInput{ServerVersion: "v1.33.0", Metrics: metrics})
	got := findingsOf(rep, "upgrade.deprecated-api.requests")
	if len(got) != 2 {
		t.Fatalf("findings = %+v", got)
	}
	byName := map[string]HygieneFinding{}
	for _, f := range got {
		byName[f.Name] = f
	}
	fs := byName["flowcontrol.apiserver.k8s.io/v1beta3/flowschemas"]
	if fs.Severity != HygieneCritical || fs.MessageKey != "deprecatedAPIRemoved" {
		t.Fatalf("removed-at-target finding = %+v", fs)
	}
	cs := byName["v1/componentstatuses"]
	if cs.Severity != HygieneWarning || cs.MessageKey != "deprecatedAPIRequested" {
		t.Fatalf("later-removal finding = %+v", cs)
	}
}

func TestUpgrade_FailClosedWebhooks(t *testing.T) {
	fail, ignore := admissionv1.Fail, admissionv1.Ignore
	svc := func(ns, name string) *admissionv1.ServiceReference {
		return &admissionv1.ServiceReference{Namespace: ns, Name: name}
	}
	cfg := admissionv1.ValidatingWebhookConfiguration{
		ObjectMeta: metav1.ObjectMeta{Name: "policy"},
		Webhooks: []admissionv1.ValidatingWebhook{
			{Name: "missing.example.com", FailurePolicy: &fail, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "gone"), CABundle: []byte("x")}},
			{Name: "empty.example.com", FailurePolicy: &fail, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "hook"), CABundle: []byte("x")}},
			{Name: "ignore.example.com", FailurePolicy: &ignore, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "gone")}},
			{Name: "all.example.com", FailurePolicy: &fail, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "ready"), CABundle: []byte("x")},
				Rules: []admissionv1.RuleWithOperations{{Rule: admissionv1.Rule{APIGroups: []string{"*"}, APIVersions: []string{"*"}, Resources: []string{"*"}}}}},
			{Name: "noca.example.com", FailurePolicy: &fail, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "ready")}},
			{Name: "fine.example.com", FailurePolicy: &fail, ClientConfig: admissionv1.WebhookClientConfig{Service: svc("ops", "ready"), CABundle: []byte("x")},
				NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"team": "x"}},
				Rules:             []admissionv1.RuleWithOperations{{Rule: admissionv1.Rule{APIGroups: []string{"*"}, APIVersions: []string{"*"}, Resources: []string{"*"}}}}},
		},
	}
	ready := true
	in := HygieneInput{
		Validating: []admissionv1.ValidatingWebhookConfiguration{cfg},
		Services:   []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Namespace: "ops", Name: "hook"}}, {ObjectMeta: metav1.ObjectMeta{Namespace: "ops", Name: "ready"}}},
		EndpointSlices: []discoveryv1.EndpointSlice{{
			ObjectMeta: metav1.ObjectMeta{Namespace: "ops", Name: "ready-abc", Labels: map[string]string{discoveryv1.LabelServiceName: "ready"}},
			Endpoints:  []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: &ready}}},
		}},
	}
	rep := upgradeReport(t, in)
	got := map[string]HygieneFinding{}
	for _, f := range findingsOf(rep, "upgrade.webhook.fail-closed") {
		got[f.Name] = f
	}
	if len(got) != 4 {
		t.Fatalf("findings = %+v", got)
	}
	if f := got["policy/missing.example.com"]; f.Severity != HygieneCritical || f.MessageKey != "webhookNoService" {
		t.Fatalf("missing service = %+v", f)
	}
	if f := got["policy/empty.example.com"]; f.Severity != HygieneCritical || f.MessageKey != "webhookNoEndpoints" {
		t.Fatalf("no endpoints = %+v", f)
	}
	if f := got["policy/all.example.com"]; f.Severity != HygieneWarning || f.MessageKey != "webhookCatchAll" {
		t.Fatalf("catch-all = %+v", f)
	}
	if f := got["policy/noca.example.com"]; f.Severity != HygieneWarning || f.MessageKey != "webhookNoCA" {
		t.Fatalf("no ca = %+v", f)
	}
	if _, ok := got["policy/fine.example.com"]; ok {
		t.Fatal("a scoped webhook with a healthy backend is fine")
	}
}

func TestUpgrade_PDBAndSkewAndIPVS(t *testing.T) {
	pdbs := []policyv1.PodDisruptionBudget{
		{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "stuck"}, Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 0, ExpectedPods: 2, CurrentHealthy: 1}},
		{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "ok"}, Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 1, ExpectedPods: 3, CurrentHealthy: 3}},
		{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "empty"}, Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 0, ExpectedPods: 0}},
	}
	nodes := []corev1.Node{
		{ObjectMeta: metav1.ObjectMeta{Name: "old"}, Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.32.7-eks-1", OSImage: "Amazon Linux 2"}}},
		{ObjectMeta: metav1.ObjectMeta{Name: "new"}, Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.37.0", OSImage: "Amazon Linux 2023.9.20260101"}}},
		{ObjectMeta: metav1.ObjectMeta{Name: "fine"}, Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.36.2", OSImage: "Bottlerocket OS 1.50.0 (aws-k8s-1.36)"}}},
	}
	in := HygieneInput{
		PDBs:  pdbs,
		Nodes: nodes,
		KubeProxyConfig: map[string]string{
			"kube-proxy":        "apiVersion: kubeproxy.config.k8s.io/v1alpha1\nkind: KubeProxyConfiguration\nmode: \"ipvs\"\n",
			"kube-proxy-config": "mode: iptables\n",
		},
		Services: []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "legacy"}, Spec: corev1.ServiceSpec{ExternalIPs: []string{"10.1.2.3"}}}},
	}
	rep := upgradeReport(t, in) // v1.36 → target v1.37

	if got := findingsOf(rep, "upgrade.pdb.blocks-drain"); len(got) != 1 || got[0].Name != "stuck" || got[0].MessageArgs["expected"] != "2" {
		t.Fatalf("pdb = %+v", got)
	}
	skew := map[string]HygieneFinding{}
	for _, f := range findingsOf(rep, "upgrade.node.skew") {
		skew[f.Name] = f
	}
	if len(skew) != 2 || skew["old"].Severity != HygieneWarning || skew["old"].MessageKey != "nodeKubeletBehind" || skew["new"].Severity != HygieneCritical {
		t.Fatalf("skew = %+v", skew)
	}
	if got := findingsOf(rep, "upgrade.kube-proxy.ipvs"); len(got) != 1 || got[0].Name != "kube-proxy" {
		t.Fatalf("ipvs = %+v", got)
	}
	if got := findingsOf(rep, "upgrade.service.external-ips"); len(got) != 1 || got[0].Severity != HygieneInfo || got[0].MessageArgs["ips"] != "10.1.2.3" {
		t.Fatalf("externalIPs = %+v", got)
	}
	if got := findingsOf(rep, "upgrade.node.cgroup-v1"); len(got) != 1 || got[0].Name != "old" {
		t.Fatalf("cgroup = %+v", got)
	}

	// Below the deprecating release the ipvs and externalIPs checks do not run.
	rep = EvaluateHygiene(in, HygieneOptions{Now: hygieneNow, TargetMinor: 34})
	if len(findingsOf(rep, "upgrade.kube-proxy.ipvs"))+len(findingsOf(rep, "upgrade.service.external-ips"))+len(findingsOf(rep, "upgrade.node.cgroup-v1")) != 0 {
		t.Fatal("checks before their release must not run")
	}
}

func TestUpgrade_PodGitRepoAndSchedulingAlpha(t *testing.T) {
	pod := compliantPod("apps", "cloner")
	pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{Name: "src", VolumeSource: corev1.VolumeSource{GitRepo: &corev1.GitRepoVolumeSource{Repository: "https://example.com/r.git"}}})
	in := HygieneInput{
		Pods:            []corev1.Pod{pod},
		Namespaces:      []corev1.Namespace{{ObjectMeta: metav1.ObjectMeta{Name: "apps", Labels: map[string]string{"pod-security.kubernetes.io/enforce": "restricted"}}}},
		NetworkPolicies: []networkingv1.NetworkPolicy{netpol("apps")},
		SchedulingAlpha: []schedulingObject{{Kind: "PodGroup", Namespace: "batch", Name: "train"}},
	}
	rep := upgradeReport(t, in)
	if got := findingsOf(rep, "upgrade.pod.git-repo"); len(got) != 1 || got[0].Name != "cloner" || got[0].MessageArgs["volume"] != "src" {
		t.Fatalf("gitRepo = %+v", got)
	}
	if got := findingsOf(rep, "upgrade.scheduling.v1alpha2"); len(got) != 1 || got[0].Namespace != "batch" || got[0].Severity != HygieneCritical {
		t.Fatalf("scheduling = %+v", got)
	}
	// An exemption on the pod applies to the upgrade check like any other.
	pod.Annotations = map[string]string{HygieneExemptAnnotation: "upgrade.pod.git-repo", HygieneExemptReasonAnnotation: "migrating in Q4"}
	in.Pods = []corev1.Pod{pod}
	rep = upgradeReport(t, in)
	if got := findingsOf(rep, "upgrade.pod.git-repo"); len(got) != 1 || !got[0].Exempt || got[0].ExemptReason != "migrating in Q4" {
		t.Fatalf("exempt = %+v", got)
	}
}
