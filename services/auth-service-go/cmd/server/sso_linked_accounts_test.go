package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// movedToSingleSignOn is the statement that makes an account one the provider took over.
const movedToSingleSignOn = "auth_source =  'oidc'"

// A provider's sign-in that reaches a self sign-up takes it over: the account becomes oidc in the statement that takes
// its password away, so the password form refuses it and an admin's reset gives it no password from then on. A
// password account holding no password, which only that sign-in leaves (a build before this one kept it a password
// account), is taken over at its next such sign-in, with its tokens kept: no password held them. An account an admin
// approved keeps its password and stays a password account.
func TestProviderSigningInToASelfSignUpMakesItAnOIDCAccount(t *testing.T) {
	currentVersion := pgRule{match: "SELECT token_version FROM auth_users WHERE id", oids: []uint32{integerOID}, rows: [][]any{{4}}}
	for _, c := range []struct {
		name                    string
		role, hash              string
		moved, removed, tokened bool
	}{
		{"waiting for approval with its sign-up's password", "Pending", "stored-hash", true, true, true},
		{"taken over by a build before, approved since", "Member", "", true, false, false},
		{"taken over by a build before, still waiting", "Pending", "", true, false, false},
		{"approved with its own password", "Member", "stored-hash", false, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startOIDCProvider(t)
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, p.settings, currentVersion, storedAccount("someone@example.com", c.role, c.hash))
			to, session := p.signIn(api, map[string]any{"email": "someone@example.com", "email_verified": true})
			if to != "/" || session == nil {
				t.Fatalf("sent to %q with session %v, want a session", to, session)
			}
			if got := api.db.ran(movedToSingleSignOn); got != c.moved {
				t.Errorf("made an oidc account = %v, want %v (%s)", got, c.moved, api.db.statement("auth_source ="))
			}
			if got := api.db.ran(clearedPassword); got != c.moved {
				t.Errorf("password statement ran = %v, want %v", got, c.moved)
			}
			if got := api.db.ran(bumpStatement); got != c.tokened {
				t.Errorf("tokens ended = %v, want %v", got, c.tokened)
			}
			rows := api.store.successes("user.account.link")
			if !c.moved {
				if len(rows) != 0 {
					t.Errorf("user.account.link rows = %+v, want none", rows)
				}
				return
			}
			if len(rows) != 1 {
				t.Fatalf("user.account.link rows = %+v, want one", rows)
			}
			var before, after map[string]any
			_ = json.Unmarshal(rows[0].Before, &before)
			_ = json.Unmarshal(rows[0].After, &after)
			if before["auth_source"] != "password" || after["auth_source"] != "oidc" || after["method"] != "oidc" || after["password_removed"] != c.removed {
				t.Errorf("user.account.link before %v after %v, want password → oidc with password_removed %v", before, after, c.removed)
			}
		})
	}
}

// An admin's reset asks what the password form asks (SignsInWithPassword): the chart's admin account, which the form
// opens whatever made it, gets a password as a password account does; under another address the same account is
// refused as one that signs in through single sign-on.
func TestPasswordResetAsksWhatThePasswordFormAsks(t *testing.T) {
	chartAdmin := func(c *config.Config) { c.DefaultAdminEmail = "Chart@Example.com" }
	for _, c := range []struct {
		name     string
		settings func(*config.Config)
		status   int
	}{
		{"the chart's admin account the provider made", chartAdmin, http.StatusOK},
		{"the same account when admin.email names another", nil, http.StatusBadRequest},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, c.settings, append(ssoAccountRules("chart", roleAdmin, "Admin"), accountFixture()...)...)
			w := api.call(api.actor(globalAdmin, nil), http.MethodPost, "/admin/users/chart/reset-password", "")
			if w.Code != c.status {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.status)
			}
			if gave := api.db.ran("SET password_hash"); gave != (c.status == http.StatusOK) {
				t.Errorf("a password reached the database = %v", gave)
			}
			if c.status == http.StatusOK {
				if !strings.Contains(w.Body.String(), "temporary_password") || len(api.store.successes("user.password.reset")) != 1 {
					t.Errorf("answer %s, success rows %+v: want the password and one row", w.Body.String(), api.store.successes("user.password.reset"))
				}
				return
			}
			if rows := api.store.failures("user.password.reset"); len(rows) != 1 || rows[0].Error != "single_sign_on_account" {
				t.Errorf("failure rows = %+v, want one single_sign_on_account", rows)
			}
		})
	}
}
