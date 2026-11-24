package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// ssoAccountRules is an account single sign-on made: no password, auth_source oidc.
func ssoAccountRules(id string, roleID int, roleName string) []pgRule {
	rules := accountRules(id, roleID, roleName)
	rules[0].rows[0][6], rules[0].rows[0][8] = "", "oidc"
	return rules
}

// An account single sign-on made signs in at the provider: a reset would give it a password beside it, whoever asks.
func TestPasswordResetRefusesAnAccountThatSignsInThroughSingleSignOn(t *testing.T) {
	for _, c := range []struct {
		name   string
		target string
		rules  []pgRule
		perms  auth.PermissionMatrix
	}{
		{"by an admin who holds what it holds", "sso", ssoAccountRules("sso", roleMember, "Member"), userAdmin},
		{"by a global admin", "sso", ssoAccountRules("sso", roleMember, "Member"), globalAdmin},
		{"one's own", "actor", ssoAccountRules("actor", roleAdmin, "Admin"), userAdmin},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, append(c.rules, accountFixture()...)...)
			w := api.call(api.actor(c.perms, nil), http.MethodPost, "/admin/users/"+c.target+"/reset-password", "")
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "single sign-on") {
				t.Fatalf("%d %s, want 400 naming single sign-on", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "temporary_password") {
				t.Errorf("the answer carries a password: %s", w.Body.String())
			}
			if api.db.ran("SET password_hash") {
				t.Error("a password reached the database")
			}
			rows := api.store.failures("user.password.reset")
			if len(rows) != 1 || rows[0].TargetID != c.target || rows[0].Error != "single_sign_on_account" ||
				!strings.Contains(string(rows[0].Before), `"auth_source":"oidc"`) {
				t.Errorf("audit failures = %+v, want one naming the account and its sign-in", rows)
			}
			if rows := api.store.successes("user.password.reset"); len(rows) != 0 {
				t.Errorf("audit successes = %+v, want none", rows)
			}
		})
	}
}

// The ceiling is asked first: an account out of reach is refused for that, whatever its sign-in.
func TestPasswordResetOfASingleSignOnAccountOutOfReachIsRefusedByTheCeiling(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, append(ssoAccountRules("sso-admin", roleAdmin, "Admin"), accountFixture()...)...)
	change := accountChange{"reset", http.MethodPost, "/admin/users/sso-admin/reset-password", "", "user.password.reset", "SET password_hash", http.StatusOK}
	wantRefused(t, api, api.call(api.actor(userAdmin, nil), change.method, change.path, change.body), change, "sso-admin")
}
