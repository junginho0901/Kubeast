package handler

import (
	"errors"
	"strings"
)

var errAdmissionPoliciesReadOnly = errors.New("admission policies are read-only (features.admissionPolicies.readOnly)")

// features.admissionPolicies.readOnly: the kinds the YAML apply and create routes
// refuse while the switch is on (the policy screens themselves are read-only; the
// shared YAML paths were the ways left to change a policy from Kubeast).
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
