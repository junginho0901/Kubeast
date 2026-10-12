package handler

import "testing"

func TestAdmissionPolicyKind(t *testing.T) {
	for _, k := range []string{"ValidatingAdmissionPolicy", "validatingadmissionpolicybinding", "MutatingAdmissionPolicy", "MutatingAdmissionPolicyBinding"} {
		if !admissionPolicyKind(k) {
			t.Fatalf("%s should be a policy kind", k)
		}
	}
	for _, k := range []string{"Deployment", "ValidatingWebhookConfiguration", "", "Policy"} {
		if admissionPolicyKind(k) {
			t.Fatalf("%s is not a policy kind", k)
		}
	}
}
