package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// GroupsElsewhere is set only when _claim_names names the claim the groups are read from.
func TestExtractClaimsSaysWhenTheGroupsAreElsewhere(t *testing.T) {
	overage := map[string]any{"groups": "src1"}
	sources := map[string]any{"src1": map[string]any{"endpoint": "https://graph.windows.net/tenant-id/users/user-id/getMemberObjects"}}
	for _, c := range []struct {
		name        string
		groupsClaim string
		raw         map[string]any
		elsewhere   bool
		groups      int
	}{
		{"Entra past the token's groups", "groups", map[string]any{"email": "a@example.com", "_claim_names": overage, "_claim_sources": sources}, true, 0},
		{"a groups claim beside the reference", "groups", map[string]any{"email": "a@example.com", "groups": []any{"g1"}, "_claim_names": overage}, true, 1},
		{"app roles as the groups claim", "roles", map[string]any{"email": "a@example.com", "roles": []any{"Kubeast.Admin"}, "_claim_names": overage}, false, 1},
		{"another claim named", "groups", map[string]any{"email": "a@example.com", "groups": []any{"g1"}, "_claim_names": map[string]any{"address": "src1"}}, false, 1},
		{"no groups claim set", "", map[string]any{"email": "a@example.com", "_claim_names": overage}, false, 0},
		{"_claim_names that is no object", "groups", map[string]any{"email": "a@example.com", "groups": []any{"g1"}, "_claim_names": "groups"}, false, 1},
		{"Entra with its groups", "groups", map[string]any{"email": "a@example.com", "groups": []any{"g1", "g2"}}, false, 2},
		{"Keycloak", "groups", map[string]any{"email": "a@example.com", "email_verified": true, "preferred_username": "a", "groups": []any{"sre"}}, false, 1},
		{"Google", "groups", map[string]any{"email": "a@example.com", "email_verified": true, "hd": "example.com"}, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := extractClaims(c.raw, config.OIDCConfig{EmailClaim: "email", NameClaim: "name", GroupsClaim: c.groupsClaim})
			if got.GroupsElsewhere != c.elsewhere || len(got.Groups) != c.groups {
				t.Fatalf("GroupsElsewhere %v with %d groups, want %v with %d", got.GroupsElsewhere, len(got.Groups), c.elsewhere, c.groups)
			}
		})
	}
}
