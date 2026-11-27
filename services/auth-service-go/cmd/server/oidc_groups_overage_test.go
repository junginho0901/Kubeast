package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

const overageRefused = "/login?error=oidc_groups_overage"

// entraOverage is the ID token Entra ID sends for a person in more groups than the token holds: no groups claim, and
// _claim_names pointing the groups at a source to read them from.
func entraOverage(extra map[string]any) map[string]any {
	claims := map[string]any{
		"email": "alice@example.com", "name": "Alice", "preferred_username": "alice@example.com",
		"_claim_names":   map[string]any{"groups": "src1"},
		"_claim_sources": map[string]any{"src1": map[string]any{"endpoint": "https://graph.windows.net/tenant-id/users/user-id/getMemberObjects"}},
	}
	for k, v := range extra {
		claims[k] = v
	}
	return claims
}

// adminsByGroup maps an Entra group object ID to Admin and syncs roles at every sign-in.
func adminsByGroup(c *config.OIDCConfig) {
	c.SyncRoles = true
	c.RoleMapping = map[string]string{"6e1c2d1a-0b7e-4f55-9c1d-3a9f8e2b7c10": "Admin"}
	c.ClusterGroupMapping = map[string]string{"6e1c2d1a-0b7e-4f55-9c1d-3a9f8e2b7c10": "prod:Admin"}
}

// wrote lists the statements that changed the database: an account made, its role, tokens, last sign-in or grants.
func (f *fakePG) wrote() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, sql := range f.seen {
		switch strings.ToUpper(strings.Fields(sql)[0]) {
		case "INSERT", "UPDATE", "DELETE":
			out = append(out, sql)
		}
	}
	return out
}

// A token whose groups are elsewhere is refused for a first sign-in and for a stored Admin alike: no account is made
// or changed, no session is set, and the failure row names the reason and the claim.
func TestSignInWhoseGroupsAreNotInTheTokenIsRefused(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings func(*config.OIDCConfig)
		account  pgRule
		claims   map[string]any
	}{
		{"a first sign-in", adminsByGroup, pgRule{match: "WHERE u.email ="}, entraOverage(nil)},
		{"a stored Admin, roles synced", adminsByGroup, storedLinkAccount("alice@example.com", "oidc", "Admin"), entraOverage(nil)},
		{"a stored Admin, roles not synced", func(o *config.OIDCConfig) {
			adminsByGroup(o)
			o.SyncRoles = false
		}, storedLinkAccount("alice@example.com", "oidc", "Admin"), entraOverage(nil)},
		{"a stored Admin whose token also carries a groups claim", adminsByGroup, storedLinkAccount("alice@example.com", "oidc", "Admin"),
			entraOverage(map[string]any{"groups": []any{"6e1c2d1a-0b7e-4f55-9c1d-3a9f8e2b7c10"}})},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startLinkProvider(t, c.settings, c.account)
			to, session := p.signIn(c.claims)
			if to != overageRefused || session {
				t.Fatalf("sent to %q, session %v, want %q and no session", to, session, overageRefused)
			}
			if w := p.db.wrote(); len(w) != 0 {
				t.Errorf("the refused sign-in changed the database: %q", w)
			}
			if rows := p.store.successes("user.login.success"); len(rows) != 0 {
				t.Errorf("success rows = %+v", rows)
			}
			rows := p.store.failures("user.login.failed")
			if len(rows) != 1 || rows[0].Error != "oidc_groups_overage" || rows[0].TargetEmail != "alice@example.com" {
				t.Fatalf("failure rows = %+v", rows)
			}
			var after map[string]any
			if err := json.Unmarshal(rows[0].After, &after); err != nil {
				t.Fatal(err)
			}
			if after["reason"] != "oidc_groups_overage" || after["claim"] != "groups" || after["method"] != "oidc" {
				t.Errorf("failure row after = %v, want reason oidc_groups_overage and claim groups", after)
			}
		})
	}
}

// The shapes that carry their groups, or none at all, sign in as they did: Entra with the groups in the token, Entra
// with app roles as the groups claim, Keycloak, and Google, whose tokens have no groups.
func TestSignInWithTheGroupsInTheTokenGoesOnAsBefore(t *testing.T) {
	for _, c := range []struct {
		name     string
		settings func(*config.OIDCConfig)
		account  pgRule
		claims   map[string]any
		roleSync bool // the stored account's role is changed (its tokens ended)
		madeAnew bool
	}{
		{"Entra, a first sign-in with its group IDs", adminsByGroup, pgRule{match: "WHERE u.email ="},
			map[string]any{"email": "alice@example.com", "groups": []any{"6e1c2d1a-0b7e-4f55-9c1d-3a9f8e2b7c10"}}, false, true},
		{"Entra, a stored Admin no longer in the admins group", adminsByGroup, storedLinkAccount("alice@example.com", "oidc", "Admin"),
			map[string]any{"email": "alice@example.com", "groups": []any{"0d6f3b52-1111-4c2a-8e0e-5b7a9c3d2e41"}}, true, false},
		{"Entra, app roles as the groups claim while the groups are elsewhere", func(o *config.OIDCConfig) {
			o.SyncRoles = true
			o.GroupsClaim = "roles"
			o.RoleMapping = map[string]string{"Kubeast.Admin": "Admin"}
		}, storedLinkAccount("alice@example.com", "oidc", "Admin"), entraOverage(map[string]any{"roles": []any{"Kubeast.Admin"}}), false, false},
		{"Entra, _claim_names naming another claim", adminsByGroup, storedLinkAccount("alice@example.com", "oidc", "Admin"),
			map[string]any{"email": "alice@example.com", "groups": []any{"6e1c2d1a-0b7e-4f55-9c1d-3a9f8e2b7c10"},
				"_claim_names": map[string]any{"address": "src1"}, "_claim_sources": map[string]any{"src1": map[string]any{"endpoint": "https://example.com/claims"}}}, false, false},
		{"Keycloak", func(o *config.OIDCConfig) {
			o.SyncRoles = true
			o.RoleMapping = map[string]string{"sre": "Member"}
		}, storedLinkAccount("alice@example.com", "oidc", "Admin"),
			map[string]any{"email": "alice@example.com", "email_verified": true, "name": "Alice", "preferred_username": "alice", "groups": []any{"sre"}}, true, false},
		{"Google", func(o *config.OIDCConfig) { o.SyncRoles = true }, storedLinkAccount("alice@example.com", "oidc", "Admin"),
			map[string]any{"email": "alice@example.com", "email_verified": true, "hd": "example.com", "name": "Alice"}, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startLinkProvider(t, c.settings, c.account)
			to, session := p.signIn(c.claims)
			if to != "/" || !session {
				t.Fatalf("sent to %q, session %v, want / with a session", to, session)
			}
			if rows := p.store.failures("user.login.failed"); len(rows) != 0 {
				t.Errorf("failure rows = %+v", rows)
			}
			if got := p.db.ran(endsTokens); got != c.roleSync {
				t.Errorf("role changed and tokens ended = %v, want %v", got, c.roleSync)
			}
			if got := p.db.ran("INSERT INTO auth_users"); got != c.madeAnew {
				t.Errorf("account made = %v, want %v", got, c.madeAnew)
			}
		})
	}
}
