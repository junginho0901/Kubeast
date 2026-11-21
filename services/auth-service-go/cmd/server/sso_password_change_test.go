package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
)

const changeToAnother = `{"current_password":"` + testPassword + `","new_password":"Another-long-phrase-77"}`

// ownAccountHolding is the actor's own account holding testPassword, made as source says.
func ownAccountHolding(t *testing.T, source string) []pgRule {
	t.Helper()
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	rules := accountRules("actor", roleMember, "Member")
	rules[0].rows[0][6], rules[0].rows[0][8] = hash, source
	return rules
}

// A password an account the provider made holds (a reset in an earlier version) is not one it changes: the change is
// refused with 400 before anything is written, as an admin's reset of it is, and the row says why.
func TestChangingThePasswordOfAnAccountTheProviderMadeIsRefused(t *testing.T) {
	api := newAuthAPI(t, pendingRequest{owner: "requester"}, ownAccountHolding(t, "oidc")...)
	w := api.call(api.actor(nil, nil), http.MethodPost, "/change-password", changeToAnother)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "single sign-on") {
		t.Fatalf("%d %s, want 400 naming single sign-on", w.Code, w.Body.String())
	}
	if api.db.ran("SET password_hash") {
		t.Error("a password reached the database")
	}
	rows := api.store.failures("user.password.change")
	if len(rows) != 1 || rows[0].TargetID != "actor" || rows[0].Error != "single_sign_on_account" ||
		!strings.Contains(string(rows[0].After), `"auth_source":"oidc"`) {
		t.Errorf("failure rows = %+v, want one naming the account and how it signs in", rows)
	}
	if rows := api.store.successes("user.password.change"); len(rows) != 0 {
		t.Errorf("success rows = %+v, want none", rows)
	}
}

// A password account, and the chart's admin account whatever made it, change their passwords as before.
func TestChangingThePasswordStillWorksForAccountsThePasswordFormOpens(t *testing.T) {
	for _, c := range []struct {
		name     string
		source   string
		settings func(*config.Config)
	}{
		{"a password account", "password", nil},
		{"the chart's admin made by the provider", "oidc", func(c *config.Config) { c.DefaultAdminEmail = "Actor@Example.com" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, c.settings, ownAccountHolding(t, c.source)...)
			if w := api.call(api.actor(nil, nil), http.MethodPost, "/change-password", changeToAnother); w.Code != http.StatusOK {
				t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
			}
			if !api.db.ran("SET password_hash") {
				t.Error("the new password never reached the database")
			}
			if rows := api.store.successes("user.password.change"); len(rows) != 1 {
				t.Errorf("success rows = %+v, want one", rows)
			}
		})
	}
}
