package security

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func newTestManager(t *testing.T) *JWTManager {
	t.Helper()
	m, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func callWithToken(t *testing.T, mw func(http.Handler) http.Handler, token string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })).ServeHTTP(rec, req)
	return rec.Code
}

func TestAuthMiddleware_TokenVersionRevokes(t *testing.T) {
	m := newTestManager(t)
	perms := auth.PermissionMatrix{"*": {"*"}}
	current := 3
	revoked := map[string]bool{}
	lookup := func(ctx context.Context, userID, apiKeyID string) (auth.SessionState, error) {
		if userID != "u1" {
			return auth.SessionState{}, fmt.Errorf("%w: no such user", auth.ErrSubjectGone)
		}
		if apiKeyID != "" && revoked[apiKeyID] {
			return auth.SessionState{}, fmt.Errorf("%w: api key revoked", auth.ErrSubjectGone)
		}
		return auth.SessionState{Version: current}, nil
	}
	mw := AuthMiddleware(m, lookup, "kubeast.token")

	tok, err := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, nil, 3)
	if err != nil {
		t.Fatal(err)
	}
	if code := callWithToken(t, mw, tok); code != http.StatusOK {
		t.Fatalf("matching tv must pass, got %d", code)
	}

	current = 4 // admin changed the role / reset the password
	if code := callWithToken(t, mw, tok); code != http.StatusUnauthorized {
		t.Fatalf("stale tv must be rejected, got %d", code)
	}

	tok2, _ := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, nil, 4)
	if code := callWithToken(t, mw, tok2); code != http.StatusOK {
		t.Fatalf("re-issued token must pass, got %d", code)
	}

	gone, _ := m.CreateToken("deleted", "x@example.com", "admin", perms, nil, nil, 0)
	if code := callWithToken(t, mw, gone); code != http.StatusUnauthorized {
		t.Fatalf("token of an unknown user must be rejected, got %d", code)
	}

	// A token an API key was exchanged for goes with the key; the user's own sign-in stays.
	keyTok, _ := m.CreateAPIKeyToken("u1", "u1@example.com", "admin", perms, nil, nil, 4, "key-1")
	if code := callWithToken(t, mw, keyTok); code != http.StatusOK {
		t.Fatalf("live key token must pass, got %d", code)
	}
	revoked["key-1"] = true
	if code := callWithToken(t, mw, keyTok); code != http.StatusUnauthorized {
		t.Fatalf("token of a revoked key must be rejected, got %d", code)
	}
	if code := callWithToken(t, mw, tok2); code != http.StatusOK {
		t.Fatalf("the sign-in token is not touched by the key, got %d", code)
	}
}

// The database restarting is not a revocation: a token whose version could not be read is refused with 503 and
// Retry-After, which the console does not read as signed out, and passes again once the read works. A version that
// moved on, a user who is gone and a signed-out sign-in stay 401.
func TestAuthMiddleware_ATokenWhoseVersionCannotBeReadIsRefusedWith503(t *testing.T) {
	m := newTestManager(t)
	perms := auth.PermissionMatrix{"*": {"*"}}
	var dbErr error
	lookup := func(ctx context.Context, userID, apiKeyID string) (auth.SessionState, error) {
		if dbErr != nil {
			return auth.SessionState{}, dbErr
		}
		if userID != "u1" {
			return auth.SessionState{}, fmt.Errorf("%w: no rows in result set", auth.ErrSubjectGone)
		}
		return auth.SessionState{Version: 3, SignedOut: []int64{1763100000}}, nil
	}
	mw := AuthMiddleware(m, lookup, "kubeast.token")
	serve := func(token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })).ServeHTTP(rec, req)
		return rec
	}
	tok, _ := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, nil, 3)

	for _, e := range []error{
		errors.New("failed to connect to `host=postgres user=kubeast database=kubeast`: dial error (dial tcp 10.96.0.5:5432: connect: connection refused)"),
		context.DeadlineExceeded,
	} {
		dbErr = e
		rec := serve(tok)
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
			t.Fatalf("%v: got %d (Retry-After %q) %s, want 503 with Retry-After", e, rec.Code, rec.Header().Get("Retry-After"), rec.Body)
		}
		if strings.Contains(rec.Body.String(), "10.96.0.5") || strings.Contains(rec.Body.String(), "postgres") {
			t.Fatalf("the answer names the database: %s", rec.Body)
		}
	}

	dbErr = nil
	if rec := serve(tok); rec.Code != http.StatusOK {
		t.Fatalf("after the database answers again: %d, want 200", rec.Code)
	}
	older, _ := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, nil, 2)
	gone, _ := m.CreateToken("deleted", "x@example.com", "admin", perms, nil, nil, 3)
	ended, _ := m.CreateTokenAt("u1", "u1@example.com", "admin", perms, nil, nil, 3, time.Unix(1763100000, 0))
	for name, token := range map[string]string{"older version": older, "user gone": gone, "signed out": ended} {
		if rec := serve(token); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d, want 401", name, rec.Code)
		}
	}
}

func TestAuthMiddleware_CarriesTheTokensClaims(t *testing.T) {
	m := newTestManager(t)
	perms := auth.PermissionMatrix{"c": {"resource.pod.read"}}
	roles := map[string]string{"c": "Read"}
	scope := map[string][]string{"c": {"team-a", "team-b"}}
	tok, err := m.CreateAPIKeyToken("u1", "u1@example.com", "member", perms, roles, scope, 0, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	var got auth.TokenPayload
	h := AuthMiddleware(m, nil, "kubeast.token")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = auth.FromContext(r.Context())
	}))
	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !reflect.DeepEqual(got.Namespaces, scope) {
		t.Errorf("Namespaces = %v, want %v", got.Namespaces, scope)
	}
	if !reflect.DeepEqual(got.Roles, roles) || got.APIKeyID != "key-1" || got.UserID != "u1" {
		t.Errorf("payload = %+v", got)
	}
	if got.AllowedIn("c", "team-c") || !got.AllowedIn("c", "team-a") {
		t.Errorf("AllowedIn does not follow the token's scope: %+v", got.Namespaces)
	}
}

func TestAuthMiddleware_CookieSessionAndCSRF(t *testing.T) {
	m := newTestManager(t)
	tok, _ := m.CreateToken("u1", "u1@example.com", "read", auth.PermissionMatrix{"*": {}}, nil, nil, 1)
	mw := AuthMiddleware(m, nil, "kubeast.token")
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	do := func(method string, cookie, bearer, xrw bool) int {
		req := httptest.NewRequest(method, "/api/v1/auth/me", nil)
		if cookie {
			req.AddCookie(&http.Cookie{Name: "kubeast.token", Value: tok})
		}
		if bearer {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		if xrw {
			req.Header.Set(auth.CSRFHeader, auth.CSRFHeaderValue)
		}
		rec := httptest.NewRecorder()
		mw(ok).ServeHTTP(rec, req)
		return rec.Code
	}
	if got := do("GET", true, false, false); got != http.StatusOK {
		t.Fatalf("cookie GET: %d", got)
	}
	if got := do("POST", true, false, false); got != http.StatusForbidden {
		t.Fatalf("cookie POST without X-Requested-With must be 403, got %d", got)
	}
	if got := do("POST", true, false, true); got != http.StatusOK {
		t.Fatalf("cookie POST with X-Requested-With: %d", got)
	}
	if got := do("POST", false, true, false); got != http.StatusOK {
		t.Fatalf("bearer POST needs no CSRF header: %d", got)
	}
	if got := do("GET", false, false, false); got != http.StatusUnauthorized {
		t.Fatalf("no credential: %d", got)
	}
}

func TestAuthMiddleware_NoLookupKeepsOldBehaviour(t *testing.T) {
	m := newTestManager(t)
	tok, _ := m.CreateToken("u1", "u1@example.com", "read", auth.PermissionMatrix{"*": {}}, map[string]string{"prod": "Read"}, nil, 9)
	if code := callWithToken(t, AuthMiddleware(m, nil, "kubeast.token"), tok); code != http.StatusOK {
		t.Fatalf("without a lookup the tv claim is not checked, got %d", code)
	}
}
