package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The version lookup answers only for the bearer's own subject; everything
// before the database read is covered here (the 200/404 paths need Postgres
// and are exercised by the e2e token-revocation spec).
func TestTokenVersion_OnlyTheSubjectsOwnToken(t *testing.T) {
	m, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	token, err := m.CreateToken("u1", "u1@example.com", "Read", auth.PermissionMatrix{}, nil, 3)
	if err != nil {
		t.Fatal(err)
	}
	other, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5) // different signing key
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := other.CreateToken("u1", "u1@example.com", "Read", auth.PermissionMatrix{}, nil, 3)
	if err != nil {
		t.Fatal(err)
	}

	h := &AuthHandler{jwtMgr: m}
	r := chi.NewRouter()
	r.Get("/internal/token-version/{userID}", h.TokenVersion)

	cases := []struct {
		name, path, authz string
		want              int
	}{
		{"no bearer", "/internal/token-version/u1", "", http.StatusUnauthorized},
		{"not a bearer scheme", "/internal/token-version/u1", "Basic abc", http.StatusUnauthorized},
		{"foreign signature", "/internal/token-version/u1", "Bearer " + foreign, http.StatusUnauthorized},
		{"another user's version", "/internal/token-version/u2", "Bearer " + token, http.StatusForbidden},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		if tc.authz != "" {
			req.Header.Set("Authorization", tc.authz)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s: got %d want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
}
