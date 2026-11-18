package main

import (
	"encoding/json"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// noRoleNamed is the database holding no role of that exact name (an upgrade renamed it, or a setting misspells it).
func noRoleNamed(name string) pgRule {
	return pgRule{match: "FROM roles WHERE name =  '" + name + "'"}
}

// A sign-in whose account level a chart setting names by a name no role holds fails with its own code, and the
// failure row names the role and the setting, so an admin can tell which value to change.
func TestSignInGivenARoleThatDoesNotExistSaysWhichOne(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings func(*config.OIDCConfig)
		account  pgRule
		claims   map[string]any
		setting  string
	}{
		{"a first sign-in mapped by roleMapping", func(o *config.OIDCConfig) { o.RoleMapping = map[string]string{"sre": "OPS"} },
			pgRule{match: "WHERE u.email ="}, map[string]any{"email": "alice@example.com", "groups": []any{"sre"}}, "auth.oidc.roleMapping"},
		{"a first sign-in mapped to no group", func(o *config.OIDCConfig) { o.DefaultRole = "OPS" },
			pgRule{match: "WHERE u.email ="}, map[string]any{"email": "alice@example.com", "groups": []any{"other"}}, "auth.oidc.defaultRole"},
		{"a role sync of a stored account", func(o *config.OIDCConfig) {
			o.SyncRoles = true
			o.RoleMapping = map[string]string{"sre": "OPS"}
		}, storedLinkAccount("alice@example.com", "oidc", "OPS-renamed-9"), map[string]any{"email": "alice@example.com", "groups": []any{"sre"}}, "auth.oidc.roleMapping"},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startLinkProvider(t, c.settings, c.account, noRoleNamed("OPS"))
			to, session := p.signIn(c.claims)
			if to != "/login?error=oidc_role_missing" || session {
				t.Fatalf("sent to %q, session %v, want oidc_role_missing and no session", to, session)
			}
			rows := p.store.failures("user.login.failed")
			if len(rows) != 1 || rows[0].Error != "oidc_role_missing" {
				t.Fatalf("failure rows = %+v", rows)
			}
			var after map[string]any
			if err := json.Unmarshal(rows[0].After, &after); err != nil {
				t.Fatal(err)
			}
			if after["role"] != "OPS" || after["setting"] != c.setting || after["reason"] != "oidc_role_missing" {
				t.Errorf("failure row after = %v, want role OPS and setting %s", after, c.setting)
			}
		})
	}
}
