package main

import "testing"

// With features.admissionPolicies.readOnly on, a resource_type or a manifest
// document naming a policy kind is refused; everything else, and everything
// with the switch off, goes through.
func TestAdmissionPolicyGate(t *testing.T) {
	was := admissionPoliciesReadOnly
	defer func() { admissionPoliciesReadOnly = was }()

	for _, rt := range []string{"ValidatingAdmissionPolicy", "validatingadmissionpolicies", "validatingadmissionpolicybindings.admissionregistration.k8s.io", "MutatingAdmissionPolicyBinding"} {
		if !admissionPolicyResource(rt) {
			t.Fatalf("%q should be a policy resource", rt)
		}
	}
	for _, rt := range []string{"deployments", "validatingwebhookconfigurations", "pods", ""} {
		if admissionPolicyResource(rt) {
			t.Fatalf("%q is not a policy resource", rt)
		}
	}
	yaml := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: admissionregistration.k8s.io/v1\nkind: ValidatingAdmissionPolicy\nmetadata:\n  name: p\n"
	if !admissionPolicyManifest(yaml) || admissionPolicyManifest("kind: Deployment\n") {
		t.Fatal("manifest kind detection")
	}
	if !admissionPolicyManifest(`{"apiVersion":"admissionregistration.k8s.io/v1","kind":"MutatingAdmissionPolicyBinding","metadata":{"name":"b"}}`) {
		t.Fatal("JSON manifest kind detection")
	}

	admissionPoliciesReadOnly = false
	if admissionPolicyGate("validatingadmissionpolicies") != nil || admissionPolicyGateManifest(yaml) != nil {
		t.Fatal("switch off: nothing is refused")
	}
	admissionPoliciesReadOnly = true
	if admissionPolicyGate("validatingadmissionpolicies") != errAdmissionPolicyReadOnly || admissionPolicyGateManifest(yaml) != errAdmissionPolicyReadOnly {
		t.Fatal("switch on: policies are refused")
	}
	if admissionPolicyGate("deployments") != nil || admissionPolicyGateManifest("kind: Deployment\n") != nil {
		t.Fatal("switch on: other kinds go through")
	}
}

// A resource_type names one or several kinds; any policy among them is a policy resource.
func TestAdmissionPolicyResourceInAList(t *testing.T) {
	for _, rt := range []string{"pods,validatingadmissionpolicies", "validatingadmissionpolicies,pods", "pods, deployments.apps,MutatingAdmissionPolicy", "configmaps,validatingadmissionpolicybindings.admissionregistration.k8s.io", "api-extensions", "pods,api-extensions"} {
		if !admissionPolicyResource(rt) {
			t.Errorf("%q names a policy kind", rt)
		}
	}
	for _, rt := range []string{"pods,deployments", "pods,", ",", "validatingwebhookconfigurations,mutatingwebhookconfigurations"} {
		if admissionPolicyResource(rt) {
			t.Errorf("%q names no policy kind", rt)
		}
	}
}

// Whichever way YAML or JSON spells it, a policy document is a policy document, and text that only mentions one is not.
func TestAdmissionPolicyManifestReadsTheKindAsKubectlDoes(t *testing.T) {
	policy := "ValidatingAdmissionPolicy"
	for name, manifest := range map[string]string{
		"plain":            "kind: " + policy + "\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"double quotes":    "kind: \"" + policy + "\"\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"single quotes":    "kind: '" + policy + "'\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"a quoted key":     "'kind': " + policy + "\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"a block scalar":   "kind: >-\n  " + policy + "\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"an anchor":        "kind: &k " + policy + "\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"a tag":            "kind: !!str " + policy + "\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"flow style":       "{kind: " + policy + ", apiVersion: admissionregistration.k8s.io/v1, metadata: {name: p}}\n",
		"JSON":             `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"` + policy + `","metadata":{"name":"p"}}`,
		"a JSON escape":    `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicy","metadata":{"name":"p"}}`,
		"a later document": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\nkind: '" + policy + "'\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  name: p\n",
		"a List":           "apiVersion: v1\nkind: List\nitems:\n- kind: '" + policy + "'\n  apiVersion: admissionregistration.k8s.io/v1\n  metadata:\n    name: p\n",
		"a typed list":     "apiVersion: admissionregistration.k8s.io/v1\nkind: " + policy + "List\nitems:\n- metadata:\n    name: p\n",
		"a generated name": "kind: '" + policy + "'\napiVersion: admissionregistration.k8s.io/v1\nmetadata:\n  generateName: p-\n",
	} {
		if !admissionPolicyManifest(manifest) {
			t.Errorf("%s: a policy document was not seen", name)
		}
	}
	for name, manifest := range map[string]string{
		"another kind":         "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\n",
		"a mention in a value": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  doc: \"kind: ValidatingAdmissionPolicy\"\n",
		"a mention in a block": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\ndata:\n  doc: |\n    kind: ValidatingAdmissionPolicy\n",
		"text":                 "not a manifest",
	} {
		if admissionPolicyManifest(manifest) {
			t.Errorf("%s: read as a policy document", name)
		}
	}
}

// With the switch on, the tools refuse a policy named in a list or a quoted manifest; with it off they do not look.
func TestAdmissionPolicyToolsRefuseAListAndAQuotedManifest(t *testing.T) {
	was := admissionPoliciesReadOnly
	defer func() { admissionPoliciesReadOnly = was }()
	registry := buildToolRegistry()
	quoted := "apiVersion: admissionregistration.k8s.io/v1\nkind: 'ValidatingAdmissionPolicy'\nmetadata:\n  name: p\n"
	calls := []struct {
		tool string
		args map[string]interface{}
	}{
		{"k8s_delete_resource", map[string]interface{}{"resource_type": "pods,validatingadmissionpolicies", "resource_name": "p"}},
		{"k8s_label_resource", map[string]interface{}{"resource_type": "pods,validatingadmissionpolicies", "resource_name": "p", "labels": map[string]interface{}{"a": "b"}}},
		{"k8s_apply_manifest", map[string]interface{}{"yaml_content": quoted}},
		{"k8s_create_resource", map[string]interface{}{"yaml_content": quoted}},
	}
	for _, c := range calls {
		admissionPoliciesReadOnly = true
		ran := fakeKubectl(t, func([]string) (string, error) { return "done", nil })
		if _, err := registry[c.tool].Handler(writerCtx(t), c.args, bearer()); err != errAdmissionPolicyReadOnly {
			t.Errorf("%s on: %v", c.tool, err)
		}
		if len(*ran) != 0 {
			t.Errorf("%s on: kubectl ran: %v", c.tool, *ran)
		}
		admissionPoliciesReadOnly = false
		ran = fakeKubectl(t, func([]string) (string, error) { return "done", nil })
		if out, err := registry[c.tool].Handler(writerCtx(t), c.args, bearer()); err != nil || out != "done" {
			t.Errorf("%s off: %q %v", c.tool, out, err)
		}
		if len(*ran) != 1 {
			t.Errorf("%s off: kubectl ran %v", c.tool, *ran)
		}
	}
}
