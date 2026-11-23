package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
)

// Runs against the PostgreSQL named by DBMIGRATE_TEST_DATABASE_URL (the CI dbmigrate job; skipped when unset): a
// throwaway database with the real migrations, accounts stored as they are made, and the lockout columns read back.
const signInDatabaseURLEnv = "DBMIGRATE_TEST_DATABASE_URL"

func signInDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv(signInDatabaseURLEnv)
	if raw == "" {
		t.Skipf("%s not set: needs a PostgreSQL server", signInDatabaseURLEnv)
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	name := fmt.Sprintf("sso_signin_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(raw)
	u.Path = "/" + name
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)")
		admin.Close(ctx)
	})
	if _, err := dbmigrate.Up(ctx, pool); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return pool
}

// More attempts than the lockout allows, the password the account holds among them: each is a wrong password's answer
// with a single_sign_on_account row, and the account is never locked. A password account and the chart's admin account
// made by the provider sign in with the same password.
func TestPostgresPasswordSignInRefusesAnAccountThatSignsInThroughSingleSignOn(t *testing.T) {
	pool := signInDatabase(t)
	ctx := context.Background()
	hash, err := security.HashPassword(testPassword, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var role int
	if err := pool.QueryRow(ctx, `INSERT INTO roles (name) VALUES ('t-member') RETURNING id`).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_users (id, name, email, password_hash, role_id, auth_source) VALUES
	  ('sso', 'SSO', 'sso@example.com', $1, $2, 'oidc'),
	  ('pw', 'PW', 'pw@example.com', $1, $2, 'password'),
	  ('chart', 'admin', 'ops@example.com', $1, $2, 'oidc')`, hash, role); err != nil {
		t.Fatal(err)
	}
	mgr, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	store := &recordedAudit{}
	h := handler.NewAuthHandler(repository.New(pool), mgr, config.Config{
		AuthCookieName: "kubeast.token", DefaultAdminEmail: "ops@example.com", PasswordHashIterations: 1000,
		JWTExpiresMinutes: 5, LoginMaxFailures: 3, LoginLockoutMinutes: 15,
	}, store)
	signIn := func(email, password string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(jsonBody(t, map[string]string{"email": email, "password": password})))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.Login(w, req)
		return w
	}

	attempts := []string{testPassword, "not-the-password-1", "", testPassword, "not-the-password-2"}
	for i, password := range attempts {
		if w := signIn("sso@example.com", password); w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Invalid credentials") {
			t.Fatalf("attempt %d: %d %s, want a wrong password's 401", i+1, w.Code, w.Body.String())
		}
	}
	var failures int
	var locked bool
	if err := pool.QueryRow(ctx, `SELECT failed_logins, locked_until IS NOT NULL FROM auth_users WHERE id = 'sso'`).Scan(&failures, &locked); err != nil {
		t.Fatal(err)
	}
	if failures != 0 || locked {
		t.Errorf("failed_logins %d, locked %v: the refusals were counted toward the lockout", failures, locked)
	}
	rows := store.failures("user.login.failed")
	if len(rows) != len(attempts) {
		t.Fatalf("failure rows = %+v, want one per attempt", rows)
	}
	for _, row := range rows {
		if row.Error != "single_sign_on_account" || row.TargetID != "sso" || !strings.Contains(string(row.After), `"auth_source":"oidc"`) {
			t.Errorf("failure row %+v, want single_sign_on_account naming the account", row)
		}
	}
	if n := len(store.failures("user.login.locked")); n != 0 {
		t.Errorf("%d user.login.locked rows, want none", n)
	}

	for _, email := range []string{"pw@example.com", "ops@example.com"} {
		if w := signIn(email, testPassword); w.Code != http.StatusOK {
			t.Errorf("%s: %d %s, want 200", email, w.Code, w.Body.String())
		}
	}
}
