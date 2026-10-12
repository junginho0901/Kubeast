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
