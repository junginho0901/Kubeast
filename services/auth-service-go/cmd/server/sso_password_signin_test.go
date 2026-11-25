package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
)

const countsAFailure = "SET failed_logins"

// signInAccount makes every lookup by address find an account holding testPassword, made as source says.
func signInAccount(t *testing.T, email, source string) pgRule {
	t.Helper()
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return storedLinkAccountHolding(hash, email, source, "Member")
}

func signInWith(api *authAPI, email, password string) *httptest.ResponseRecorder {
	api.t.Helper()
	return api.raw("", http.MethodPost, "/api/v1/auth/login", jsonBody(api.t, map[string]string{"email": email, "password": password}))
}

func setsASession(w *httptest.ResponseRecorder) bool {
	for _, c := range w.Result().Cookies() {
		if c.Value != "" {
			return true
		}
	}
	return false
}

// A password an account the provider made was given (a reset in an earlier version) does not sign it in, also when
// admin.email names its address in other letters: the chart's admin account is the one stored as written. The answer
// is a wrong password's, the row says why, and no failure is counted toward the lockout.
func TestPasswordSignInRefusesAnAccountThatSignsInThroughSingleSignOn(t *testing.T) {
	wrong := newAuthAPI(t, pendingRequest{owner: "requester"}, signInAccount(t, "pw@example.com", "password"))
	wrongAnswer := signInWith(wrong, "pw@example.com", "not-the-password-1")
	locked := signInAccount(t, "sso@example.com", "oidc")
	locked.rows[0][13] = time.Now().Add(time.Hour).UTC().Format(pgTimestamp) // locked_until, from failures before the upgrade
	otherLetters := func(c *config.Config) { c.DefaultAdminEmail = "Sso@Example.com" }
	for _, c := range []struct {
		name     string
		settings func(*config.Config)
		account  pgRule
		password string
	}{
		{"the password it was given", nil, signInAccount(t, "sso@example.com", "oidc"), testPassword},
		{"a wrong password", nil, signInAccount(t, "sso@example.com", "oidc"), "not-the-password-1"},
		{"no password", nil, signInAccount(t, "sso@example.com", "oidc"), ""},
		{"while a lock from earlier failures stands", nil, locked, testPassword},
		{"admin.email naming its address in other letters", otherLetters, signInAccount(t, "sso@example.com", "oidc"), testPassword},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, c.settings, c.account)
			w := signInWith(api, "sso@example.com", c.password)
			if w.Code != wrongAnswer.Code || w.Body.String() != wrongAnswer.Body.String() {
				t.Fatalf("%d %s, want a wrong password's answer %d %s", w.Code, w.Body.String(), wrongAnswer.Code, wrongAnswer.Body.String())
			}
			if setsASession(w) || strings.Contains(w.Body.String(), "access_token") {
				t.Errorf("the answer holds a session: %v %s", w.Result().Cookies(), w.Body.String())
			}
			rows := api.store.failures("user.login.failed")
			if len(rows) != 1 || rows[0].Error != "single_sign_on_account" || rows[0].TargetEmail != "sso@example.com" ||
				!strings.Contains(string(rows[0].After), `"auth_source":"oidc"`) {
				t.Errorf("failure rows = %+v, want one naming the account and how it signs in", rows)
			}
			if api.db.ran(countsAFailure) || len(api.store.failures("user.login.locked")) != 0 {
				t.Error("the refusal was counted toward the lockout")
			}
			if rows := api.store.successes("user.login.success"); len(rows) != 0 {
				t.Errorf("success rows = %+v, want none", rows)
			}
		})
	}
}

// A password account signs in and counts its failures as before, and the chart's admin account signs in with its
// password whatever made it: reset-admin gives it one without changing that, and it is the way in while the provider
// is down.
func TestPasswordSignInStillOpensPasswordAccountsAndTheChartAdmin(t *testing.T) {
	chartAdmin := func(email, mode string) func(*config.Config) {
		return func(c *config.Config) { c.DefaultAdminEmail, c.PasswordLogin = email, mode }
	}
	for _, c := range []struct {
		name     string
		settings func(*config.Config)
		account  pgRule
		typed    string
	}{
		{"a password account", nil, signInAccount(t, "pw@example.com", "password"), "pw@example.com"},
		{"the chart's admin made by the provider", chartAdmin("ops@example.com", "on"), signInAccount(t, "ops@example.com", "oidc"), "ops@example.com"},
		{"the same with only the admin's password sign-in", chartAdmin("ops@example.com", "admin-only"), signInAccount(t, "ops@example.com", "oidc"), "ops@example.com"},
		{"the chart's admin under its default name", chartAdmin("admin", "on"), signInAccount(t, "admin", "oidc"), "admin"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, c.settings, c.account)
			if w := signInWith(api, c.typed, testPassword); w.Code != http.StatusOK {
				t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
			}
			if rows := api.store.successes("user.login.success"); len(rows) != 1 {
				t.Errorf("success rows = %+v, want one", rows)
			}
		})
	}
	t.Run("a password account's wrong password", func(t *testing.T) {
		api := newAuthAPI(t, pendingRequest{owner: "requester"}, signInAccount(t, "pw@example.com", "password"))
		if w := signInWith(api, "pw@example.com", "not-the-password-1"); w.Code != http.StatusUnauthorized {
			t.Fatalf("%d %s, want 401", w.Code, w.Body.String())
		}
		if rows := api.store.failures("user.login.failed"); len(rows) != 1 || rows[0].Error != "password_mismatch" {
			t.Errorf("failure rows = %+v, want one password_mismatch", rows)
		}
		if !api.db.ran(countsAFailure) {
			t.Error("the failure was not counted toward the lockout")
		}
	})
}

// admin-only opens the password form to the account stored under admin.email as written and to no other: a password
// account whose address differs from it only in letter case (a self sign-up keeps the letters it was typed in) is
// refused before it is looked up, as any other address is.
func TestAdminOnlyOpensThePasswordFormToTheAdminAddressAsWritten(t *testing.T) {
	adminOnly := func(email string) func(*config.Config) {
		return func(c *config.Config) { c.DefaultAdminEmail, c.PasswordLogin = email, "admin-only" }
	}
	t.Run("the address as written", func(t *testing.T) {
		api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, adminOnly("Ops@Example.com"), signInAccount(t, "Ops@Example.com", "password"))
		if w := signInWith(api, "Ops@Example.com", testPassword); w.Code != http.StatusOK {
			t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
		}
		if rows := api.store.successes("user.login.success"); len(rows) != 1 {
			t.Errorf("success rows = %+v, want one", rows)
		}
	})
	for _, c := range []struct {
		name, admin, stored string
	}{
		{"a password account in small letters", "Ops@Example.com", "ops@example.com"},
		{"a password account in capitals", "Ops@Example.com", "OPS@EXAMPLE.COM"},
		{"the default name in other letters", "admin", "Admin"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, adminOnly(c.admin), signInAccount(t, c.stored, "password"))
			w := signInWith(api, c.stored, testPassword)
			if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "Password login is disabled") {
				t.Fatalf("%d %s, want 403 password login is disabled", w.Code, w.Body.String())
			}
			if setsASession(w) || strings.Contains(w.Body.String(), "access_token") {
				t.Errorf("the answer holds a session: %v %s", w.Result().Cookies(), w.Body.String())
			}
			if rows := api.store.failures("user.login.failed"); len(rows) != 1 || rows[0].Error != "password_login_disabled" || rows[0].TargetEmail != c.stored {
				t.Errorf("failure rows = %+v, want one password_login_disabled naming the address typed", rows)
			}
			if api.db.ran("WHERE u.email =") || api.db.ran(countsAFailure) {
				t.Error("the refused address was looked up or counted toward the lockout")
			}
			if rows := api.store.successes("user.login.success"); len(rows) != 0 {
				t.Errorf("success rows = %+v, want none", rows)
			}
		})
	}
	t.Run("on: the same account in other letters still signs in", func(t *testing.T) {
		on := func(c *config.Config) { c.DefaultAdminEmail, c.PasswordLogin = "Ops@Example.com", "on" }
		api := newAuthAPIWith(t, pendingRequest{owner: "requester"}, on, signInAccount(t, "ops@example.com", "password"))
		if w := signInWith(api, "ops@example.com", testPassword); w.Code != http.StatusOK {
			t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
		}
	})
}
