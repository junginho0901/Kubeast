package main

import (
	"errors"
	"os"
	"regexp"
	"strings"
)

// features.admissionPolicies.readOnly (ADMISSION_POLICIES_READ_ONLY): the write
// tools refuse ValidatingAdmissionPolicy, MutatingAdmissionPolicy and their
// bindings, the rule k8s-service applies to the YAML apply route, so policies
// change only through Git while the switch is on.
var (
	admissionPoliciesReadOnly  = strings.EqualFold(os.Getenv("ADMISSION_POLICIES_READ_ONLY"), "true")
	errAdmissionPolicyReadOnly = errors.New("admission policies are read-only (features.admissionPolicies.readOnly)")
	manifestKindLine           = regexp.MustCompile(`(?i)(?:^|[\s{,])"?kind"?\s*:\s*"?([A-Za-z]+)`)
)

var admissionPolicyResources = map[string]struct{}{
	"validatingadmissionpolicy": {}, "validatingadmissionpolicies": {},
	"validatingadmissionpolicybinding": {}, "validatingadmissionpolicybindings": {},
	"mutatingadmissionpolicy": {}, "mutatingadmissionpolicies": {},
	"mutatingadmissionpolicybinding": {}, "mutatingadmissionpolicybindings": {},
}

// admissionPolicyResource reports whether a resource_type argument (kind,
// singular or plural, with or without the API group) names a policy kind.
func admissionPolicyResource(resourceType string) bool {
	t := strings.ToLower(strings.TrimSpace(resourceType))
	if i := strings.Index(t, "."); i > 0 {
		t = t[:i]
	}
	_, ok := admissionPolicyResources[t]
	return ok
}

// admissionPolicyManifest reports whether any document of a YAML or JSON
// manifest is a policy kind.
func admissionPolicyManifest(manifest string) bool {
	for _, m := range manifestKindLine.FindAllStringSubmatch(manifest, -1) {
		if admissionPolicyResource(m[1]) {
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
