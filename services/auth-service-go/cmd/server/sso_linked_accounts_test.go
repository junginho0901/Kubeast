package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// movedToSingleSignOn is the part of the statement that makes an account one the provider took over.
const movedToSingleSignOn = "auth_source =  'oidc'"

// times counts the statements containing text that reached the database.
func (f *fakePG) times(text string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, sql := range f.seen {
		if strings.Contains(sql, text) {
			n++
		}
	}
	return n
}

// A provider's sign-in that reaches a self sign-up takes it over: one statement makes the account oidc, takes its
// password away and ends its tokens when it held one, so the password form refuses it and an admin's reset gives it no
// password from then on. A self sign-up holding no password, which only that sign-in leaves (a build before this one
// kept it a password account), is taken over at its next such sign-in, its tokens kept: no password held them. The
// sign-in's token carries the version the statement left. An account an admin made, Pending or not, a self sign-up an
// admin approved and the chart's admin account keep their passwords, and the statement is not sent for them. When the
// statement finds the account no longer to take over (another sign-in took it over first), the sign-in reads the
// account again and goes on from it, writing no row.
func TestProviderSigningInToASelfSignUpMakesItAnOIDCAccount(t *testing.T) {
	const email = "someone@example.com"
	for _, c := range []struct {
		name     string
		admin    string // admin.email
		account  pgRule
		answer   *pgRule // the statement's answer; nil = no row, as for an account no longer to take over
		sent     bool    // the statement reached the database
		moved    bool
		removed  bool
		reads    int // lookups of the account by address
		tokenVer float64
	}{
		{"waiting for approval with its sign-up's password", "", storedSelfSignUp(email, "Pending", "stored-hash"), ptrRule(takenOver(5, true)), true, true, true, 1, 5},
		{"taken over by a build before, approved since", "", storedSelfSignUp(email, "Member", ""), ptrRule(takenOver(0, false)), true, true, false, 1, 0},
		{"taken over by a build before, still waiting", "", storedSelfSignUp(email, "Pending", ""), ptrRule(takenOver(0, false)), true, true, false, 1, 0},
		{"a self sign-up approved with its own password", "", storedSelfSignUp(email, "Member", "stored-hash"), nil, false, false, false, 1, 0},
		{"an account an admin made, waiting", "", storedAccount(email, "Pending", "stored-hash"), nil, false, false, false, 1, 0},
		{"an account an admin made, holding no password", "", storedAccount(email, "Member", ""), nil, false, false, false, 1, 0},
		{"the chart's admin account, waiting", email, storedSelfSignUp(email, "Pending", "stored-hash"), nil, false, false, false, 1, 0},
		{"the chart's admin address in other letters, waiting", "Someone@Example.com", storedSelfSignUp(email, "Pending", "stored-hash"), ptrRule(takenOver(1, true)), true, true, true, 1, 1},
		{"taken over by another sign-in first", "", storedSelfSignUp(email, "Pending", "stored-hash"), nil, true, false, false, 2, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := startOIDCProvider(t)
			settings := func(cfg *config.Config) {
				p.settings(cfg)
				if c.admin != "" {
					cfg.DefaultAdminEmail = c.admin
				}
			}
			rules := []pgRule{c.account}
			if c.answer != nil {
				rules = append([]pgRule{*c.answer}, rules...)
			}
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, settings, rules...)
			to, session := p.signIn(api, map[string]any{"email": email, "email_verified": true})
			if to != "/" || session == nil {
				t.Fatalf("sent to %q with session %v, want a session", to, session)
			}
			statement := api.db.statement(movesToSingleSignOn)
			if got := statement != ""; got != c.sent {
				t.Errorf("statement sent = %v, want %v", got, c.sent)
			}
			if c.sent {
				for _, part := range []string{movedToSingleSignOn, clearedPassword, "u.self_signed_up", "u.auth_source =  'password'", "ro.name =  'Pending'", "FOR UPDATE"} {
					if !strings.Contains(statement, part) {
						t.Errorf("statement %q does not hold %q", statement, part)
					}
				}
			}
			if api.db.ran(bumpStatement) {
				t.Error("tokens ended by a statement of their own")
			}
			if n := api.db.times("u.role_id WHERE u.email ="); n != c.reads {
				t.Errorf("%d lookups by address, want %d", n, c.reads)
			}
			if session["tv"] != c.tokenVer {
				t.Errorf("session token version %v, want %v", session["tv"], c.tokenVer)
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

func ptrRule(r pgRule) *pgRule { return &r }

// An admin's reset asks what the password form asks (SignsInWithPassword): the chart's admin account, which the form
// opens whatever made it, gets a password as a password account does. The chart's admin account is the one stored under
// admin.email as written: under another address, or one that differs from it only in letter case, the same account is
// refused as one that signs in through single sign-on.
func TestPasswordResetAsksWhatThePasswordFormAsks(t *testing.T) {
	adminEmail := func(email string) func(*config.Config) {
		return func(c *config.Config) { c.DefaultAdminEmail = email }
	}
	for _, c := range []struct {
		name     string
		settings func(*config.Config)
		status   int
	}{
		{"the chart's admin account the provider made", adminEmail("chart@example.com"), http.StatusOK},
		{"the same account when admin.email names another", nil, http.StatusBadRequest},
		{"the same account when admin.email names it in other letters", adminEmail("Chart@Example.com"), http.StatusBadRequest},
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
