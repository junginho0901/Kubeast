package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// On the real migrations: a self sign-up made through the sign-up form is marked so, and the provider's sign-in that
// reaches it while it waits stores it as an oidc account with no password and its tokens ended. Once an admin approves
// it the password form refuses its sign-up password with a wrong password's answer, an admin's reset is refused and
// reset-admin says it signs in through the provider. A self sign-up an admin approved before the provider reached it,
// an account an admin made as Pending, and one an admin made whose role sync left it Pending (defaultRole) keep their
// passwords and stay password accounts through the provider's sign-ins. A password account and the chart's admin
// account made by the provider sign in with their passwords, and the chart's admin account takes an admin's reset.
func TestPostgresASelfSignUpTheProviderReachedSignsInOnlyThroughIt(t *testing.T) {
	pool := signInDatabase(t)
	ctx := context.Background()
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var pending, member int
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ('Pending', true) RETURNING id`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name, is_system) VALUES ('Member', true) RETURNING id`).Scan(&member); err != nil {
		t.Fatal(err)
	}
	// Accounts an admin made, as the user form stores them (self_signed_up left at its default).
	if _, err := pool.Exec(ctx, `INSERT INTO auth_users (id, name, email, password_hash, role_id, auth_source) VALUES
	  ('made-pending', 'Made Pending', 'made-pending@example.com', $1, $2, 'password'),
	  ('made-synced', 'Made Synced', 'made-synced@example.com', $1, $3, 'password'),
	  ('pw', 'PW', 'pw@example.com', $1, $3, 'password'),
	  ('chart', 'admin', 'ops@example.com', $1, $3, 'oidc')`, hash, pending, member); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DefaultAdminEmail: "ops@example.com", PasswordHashIterations: 1000, LoginMaxFailures: 3, LoginLockoutMinutes: 15,
		AllowRegistration: true}
	// A sign-in naming groups re-applies them, and one naming none of the mapped groups gets defaultRole.
	p := startLinkProviderOn(t, pool, func(c *config.OIDCConfig) {
		c.SyncRoles, c.DefaultRole, c.RoleMapping = true, "Pending", map[string]string{"engineering": "Member"}
	}, cfg)
	stored := func(id string) (source, password string, version int) {
		t.Helper()
		if err := pool.QueryRow(ctx, `SELECT auth_source, password_hash, token_version FROM auth_users WHERE id = $1`, id).Scan(&source, &password, &version); err != nil {
			t.Fatal(err)
		}
		return source, password, version
	}
	signUp := func(name, email string) string {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(jsonBody(t, map[string]string{"name": name, "email": email, "password": testPassword})))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		p.auth.Register(w, req)
		var made struct {
			ID string `json:"id"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &made) != nil || made.ID == "" {
			t.Fatalf("sign-up of %s: %d %s", email, w.Code, w.Body.String())
		}
		var marked bool
		if err := pool.QueryRow(ctx, `SELECT self_signed_up FROM auth_users WHERE id = $1`, made.ID).Scan(&marked); err != nil || !marked {
			t.Fatalf("sign-up of %s: self_signed_up %v, %v; want true", email, marked, err)
		}
		return made.ID
	}
	signup := signUp("Sign-up", "signup@example.com")
	approved := signUp("Approved", "approved@example.com")
	if _, err := pool.Exec(ctx, `UPDATE auth_users SET role_id = $1 WHERE id = $2`, member, approved); err != nil { // approved before the provider reaches it
		t.Fatal(err)
	}
	signIn := func(email, password string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(jsonBody(t, map[string]string{"email": email, "password": password})))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		p.auth.Login(w, req)
		return w
	}
	reset := func(id string) *httptest.ResponseRecorder {
		route := chi.NewRouteContext()
		route.URLParams.Add("user_id", id)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/admin/users/"+id+"/reset-password", nil)
		req = req.WithContext(auth.WithPayload(context.WithValue(req.Context(), chi.RouteCtxKey, route),
			auth.TokenPayload{UserID: "root", Email: "root@example.com", Perms: auth.PermissionMatrix{"*": {"*"}}}))
		w := httptest.NewRecorder()
		p.auth.AdminResetPassword(w, req)
		return w
	}

	if w := signIn("signup@example.com", testPassword); w.Code != http.StatusOK {
		t.Fatalf("the sign-up's password before the provider reached it: %d %s, want 200", w.Code, w.Body.String())
	}
	if to, session := p.signIn(map[string]any{"email": "signup@example.com", "email_verified": true}); to != "/" || !session {
		t.Fatalf("provider sign-in: sent to %q, session %v", to, session)
	}
	if source, password, version := stored(signup); source != "oidc" || password != "" || version != 1 {
		t.Fatalf("after the provider's sign-in: auth_source %s, password held %v, token_version %d; want oidc, none, 1", source, password != "", version)
	}
	links := p.store.successes("user.account.link")
	if len(links) != 1 || links[0].TargetID != signup || !strings.Contains(string(links[0].After), `"auth_source":"oidc"`) ||
		!strings.Contains(string(links[0].After), `"password_removed":true`) {
		t.Fatalf("user.account.link rows = %+v, want one making signup oidc with its password removed", links)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_users SET role_id = $1 WHERE id = $2`, member, signup); err != nil { // an admin approves it
		t.Fatal(err)
	}

	for _, password := range []string{testPassword, "not-the-password-1"} {
		if w := signIn("signup@example.com", password); w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Invalid credentials") {
			t.Errorf("password sign-in of the approved account: %d %s, want a wrong password's 401", w.Code, w.Body.String())
		}
	}
	for _, row := range p.store.failures("user.login.failed") {
		if row.Error != "single_sign_on_account" || row.TargetID != signup {
			t.Errorf("failure row %+v, want single_sign_on_account naming signup", row)
		}
	}
	if n := len(p.store.failures("user.login.failed")); n != 2 {
		t.Errorf("%d user.login.failed rows, want 2", n)
	}
	if w := reset(signup); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "single sign-on") {
		t.Errorf("reset: %d %s, want 400 naming single sign-on", w.Code, w.Body.String())
	}
	if _, password, _ := stored(signup); password != "" {
		t.Error("the refused reset left a password")
	}
	user, err := repository.New(pool).GetUserByEmail(ctx, "signup@example.com")
	if err != nil || user == nil {
		t.Fatalf("account %+v, %v", user, err)
	}
	if line := signInLine(cfg, user); !strings.Contains(line, "single sign-on") {
		t.Errorf("reset-admin's last line %q, want single sign-on", line)
	}

	if to, session := p.signIn(map[string]any{"email": "approved@example.com", "email_verified": true}); to != "/" || !session {
		t.Fatalf("provider sign-in of the approved self sign-up: sent to %q, session %v", to, session)
	}
	// An account an admin made as Pending, and one an admin made that a sign-in naming no mapped group moves to
	// defaultRole (Pending) and the next sign-in reaches there.
	if to, session := p.signIn(map[string]any{"email": "made-pending@example.com", "email_verified": true}); to != "/" || !session {
		t.Fatalf("provider sign-in of the account made Pending: sent to %q, session %v", to, session)
	}
	for i := 0; i < 2; i++ {
		if to, session := p.signIn(map[string]any{"email": "made-synced@example.com", "email_verified": true, "groups": []any{"other"}}); to != "/" || !session {
			t.Fatalf("provider sign-in %d of the account made Member: sent to %q, session %v", i+1, to, session)
		}
	}
	var syncedRole string
	if err := pool.QueryRow(ctx, `SELECT r.name FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.id = 'made-synced'`).Scan(&syncedRole); err != nil || syncedRole != "Pending" {
		t.Fatalf("role of the account made Member after the sign-ins: %q, %v; want Pending (defaultRole)", syncedRole, err)
	}
	// token_version: the role sync to Pending ended the tokens of made-synced once, and nothing else did.
	for id, wantVersion := range map[string]int{approved: 0, "made-pending": 0, "made-synced": 1} {
		if source, password, version := stored(id); source != "password" || password != hash || version != wantVersion {
			t.Errorf("%s after the provider's sign-ins: auth_source %s, password kept %v, token_version %d; want password, kept, %d",
				id, source, password == hash, version, wantVersion)
		}
	}
	if links := p.store.successes("user.account.link"); len(links) != 1 {
		t.Errorf("user.account.link rows = %+v, want only the one of the waiting self sign-up", links)
	}
	for _, email := range []string{"approved@example.com", "made-pending@example.com", "made-synced@example.com", "pw@example.com", "ops@example.com"} {
		if w := signIn(email, testPassword); w.Code != http.StatusOK {
			t.Errorf("%s: %d %s, want 200", email, w.Code, w.Body.String())
		}
	}
	w := reset("chart")
	var answer struct {
		TemporaryPassword string `json:"temporary_password"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &answer) != nil || answer.TemporaryPassword == "" {
		t.Fatalf("reset of the chart's admin account: %d %s, want 200 with a password", w.Code, w.Body.String())
	}
	if w := signIn("ops@example.com", answer.TemporaryPassword); w.Code != http.StatusOK {
		t.Errorf("the chart's admin account with the reset's password: %d %s, want 200", w.Code, w.Body.String())
	}
}
