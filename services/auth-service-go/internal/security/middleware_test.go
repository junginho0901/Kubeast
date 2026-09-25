package security

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

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
	lookup := func(ctx context.Context, userID string) (int, error) {
		if userID != "u1" {
			return 0, errors.New("no such user")
		}
		return current, nil
	}
	mw := AuthMiddleware(m, lookup)

	tok, err := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, 3)
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

	tok2, _ := m.CreateToken("u1", "u1@example.com", "admin", perms, nil, 4)
	if code := callWithToken(t, mw, tok2); code != http.StatusOK {
		t.Fatalf("re-issued token must pass, got %d", code)
	}

	gone, _ := m.CreateToken("deleted", "x@example.com", "admin", perms, nil, 0)
	if code := callWithToken(t, mw, gone); code != http.StatusUnauthorized {
		t.Fatalf("token of an unknown user must be rejected, got %d", code)
	}
}

func TestAuthMiddleware_NoLookupKeepsOldBehaviour(t *testing.T) {
	m := newTestManager(t)
	tok, _ := m.CreateToken("u1", "u1@example.com", "read", auth.PermissionMatrix{"*": {}}, map[string]string{"prod": "Read"}, 9)
	if code := callWithToken(t, AuthMiddleware(m, nil), tok); code != http.StatusOK {
		t.Fatalf("without a lookup the tv claim is not checked, got %d", code)
	}
}
