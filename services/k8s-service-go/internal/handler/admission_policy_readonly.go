package handler

import "strings"

// features.admissionPolicies.readOnly: the kinds the YAML apply route refuses
// while the switch is on (the policy screens themselves are read-only; the
// shared YAML path was the one way left to change a policy from Kubeast).
var admissionPolicyKinds = map[string]struct{}{
	"validatingadmissionpolicy":        {},
	"validatingadmissionpolicybinding": {},
	"mutatingadmissionpolicy":          {},
	"mutatingadmissionpolicybinding":   {},
}

func admissionPolicyKind(kind string) bool {
	_, ok := admissionPolicyKinds[strings.ToLower(kind)]
	return ok
}
