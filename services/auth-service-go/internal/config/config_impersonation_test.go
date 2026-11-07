package config

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

func TestLoadImpersonationCustomRoles(t *testing.T) {
	t.Setenv("IMPERSONATION_CUSTOM_ROLES", "sre-readonly, ops")
	if got := Load().ImpersonationCustomRoles; !slices.Equal(got, []string{"sre-readonly", "ops"}) {
		t.Errorf("got %v", got)
	}
	t.Setenv("IMPERSONATION_CUSTOM_ROLES", "")
	if got := Load().ImpersonationCustomRoles; len(got) != 0 {
		t.Errorf("empty value: got %v", got)
	}
}

// The chart hands the list over under the name this service reads: another name
// would leave every chart name open with no test failing.
func TestChartSetsImpersonationCustomRoles(t *testing.T) {
	raw, err := os.ReadFile("../../../../helm/kubeast/templates/configmap.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^\s*IMPERSONATION_CUSTOM_ROLES: `).Match(raw) {
		t.Error("templates/configmap.yaml does not set IMPERSONATION_CUSTOM_ROLES")
	}
}
