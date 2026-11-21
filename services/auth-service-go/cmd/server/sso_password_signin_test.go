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

// A password an account the provider made was given (an admin's reset before 0.7.9) does not sign it in. The answer is
// a wrong password's, the row says why, and no failure is counted toward the lockout.
func TestPasswordSignInRefusesAnAccountThatSignsInThroughSingleSignOn(t *testing.T) {
	wrong := newAuthAPI(t, pendingRequest{owner: "requester"}, signInAccount(t, "pw@example.com", "password"))
	wrongAnswer := signInWith(wrong, "pw@example.com", "not-the-password-1")
	locked := signInAccount(t, "sso@example.com", "oidc")
	locked.rows[0][13] = time.Now().Add(time.Hour).UTC().Format(pgTimestamp) // locked_until, from failures before the upgrade
	for _, c := range []struct {
		name     string
		account  pgRule
		password string
	}{
		{"the password it was given", signInAccount(t, "sso@example.com", "oidc"), testPassword},
		{"a wrong password", signInAccount(t, "sso@example.com", "oidc"), "not-the-password-1"},
		{"no password", signInAccount(t, "sso@example.com", "oidc"), ""},
		{"while a lock from earlier failures stands", locked, testPassword},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, c.account)
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
		{"the chart's admin made by the provider", chartAdmin("Ops@Example.com", "on"), signInAccount(t, "ops@example.com", "oidc"), "ops@example.com"},
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
