package main

import (
	"errors"
	"os"
	"strings"
)

// features.admissionPolicies.readOnly (ADMISSION_POLICIES_READ_ONLY): the write
// tools refuse ValidatingAdmissionPolicy, MutatingAdmissionPolicy and their
// bindings, the rule k8s-service applies to the YAML apply route, so policies
// change only through Git while the switch is on.
var (
	admissionPoliciesReadOnly  = strings.EqualFold(os.Getenv("ADMISSION_POLICIES_READ_ONLY"), "true")
	errAdmissionPolicyReadOnly = errors.New("admission policies are read-only (features.admissionPolicies.readOnly)")
)

// api-extensions is the kubectl category these kinds belong to; they have no short names.
var admissionPolicyResources = map[string]struct{}{
	"api-extensions":            {},
	"validatingadmissionpolicy": {}, "validatingadmissionpolicies": {},
	"validatingadmissionpolicybinding": {}, "validatingadmissionpolicybindings": {},
	"mutatingadmissionpolicy": {}, "mutatingadmissionpolicies": {},
	"mutatingadmissionpolicybinding": {}, "mutatingadmissionpolicybindings": {},
}

// admissionPolicyResource reports whether a resource_type argument (kinds,
// singular or plural, with or without the API group, one or several separated
// by commas) names a policy kind.
func admissionPolicyResource(resourceType string) bool {
	for _, one := range strings.Split(resourceType, ",") {
		t := strings.ToLower(strings.TrimSpace(one))
		if i := strings.Index(t, "."); i > 0 {
			t = t[:i]
		}
		if _, ok := admissionPolicyResources[t]; ok {
			return true
		}
	}
	return false
}

// admissionPolicyManifest reports whether any object of a YAML or JSON manifest
// is a policy kind.
func admissionPolicyManifest(manifest string) bool {
	for _, o := range manifestObjects(manifest) {
		if admissionPolicyResource(o.Kind) {
			return true
		}
	}
	return false
}

func admissionPolicyGate(resourceType string) error {
	if admissionPoliciesReadOnly && admissionPolicyResource(resourceType) {
		return errAdmissionPolicyReadOnly
	}
	return nil
}

func admissionPolicyGateManifest(manifest string) error {
	if admissionPoliciesReadOnly && admissionPolicyManifest(manifest) {
		return errAdmissionPolicyReadOnly
	}
	return nil
}
