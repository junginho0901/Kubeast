package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
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
	token, err := m.CreateToken("u1", "u1@example.com", "Read", auth.PermissionMatrix{}, nil, nil, 3)
	if err != nil {
		t.Fatal(err)
	}
	other, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5) // different signing key
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := other.CreateToken("u1", "u1@example.com", "Read", auth.PermissionMatrix{}, nil, nil, 3)
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

func investigatorHandler(t *testing.T, enabled bool) (*AuthHandler, *security.JWTManager) {
	t.Helper()
	m, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	h := &AuthHandler{jwtMgr: m, cfg: config.Config{AlertInvestigationEnabled: enabled, InvestigatorTokenMinutes: 7},
		listClusterIDs: func(context.Context) ([]string, error) { return []string{"self", "default"}, nil }}
	return h, m
}

func postInvestigatorToken(h *AuthHandler, body string) *httptest.ResponseRecorder {
	r := chi.NewRouter()
	r.Post("/internal/investigator-token", h.InvestigatorToken)
	req := httptest.NewRequest(http.MethodPost, "/internal/investigator-token", strings.NewReader(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// The investigator's token: off → 404, a bad request → 400, a cluster Kubeast
// does not know → 404; otherwise a token for that cluster only, with the read
// AI tools, the namespace when given, sys "investigator" and the configured
// lifetime.
func TestInvestigatorToken(t *testing.T) {
	off, _ := investigatorHandler(t, false)
	if rec := postInvestigatorToken(off, `{"cluster_id":"self"}`); rec.Code != http.StatusNotFound {
		t.Fatalf("feature off: got %d", rec.Code)
	}

	h, m := investigatorHandler(t, true)
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"not json", `cluster=self`, http.StatusBadRequest},
		{"no cluster", `{"namespace":"apps"}`, http.StatusBadRequest},
		{"every cluster", `{"cluster_id":"*"}`, http.StatusBadRequest},
		{"bad namespace", `{"cluster_id":"self","namespace":"Apps/../x"}`, http.StatusBadRequest},
		{"unknown cluster", `{"cluster_id":"prod"}`, http.StatusNotFound},
	} {
		if rec := postInvestigatorToken(h, tc.body); rec.Code != tc.want {
			t.Fatalf("%s: got %d want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}

	for _, tc := range []struct{ body, ns string }{{`{"cluster_id":"default","namespace":"apps"}`, "apps"}, {`{"cluster_id":"default"}`, ""}} {
		rec := postInvestigatorToken(h, tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d (%s)", tc.body, rec.Code, rec.Body.String())
		}
		var out struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out.ExpiresIn != 7*60 {
			t.Fatalf("expires_in: %d", out.ExpiresIn)
		}
		claims, err := m.ValidateToken(out.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		if claims["sub"] != "system" || claims["email"] != auth.UserInvestigator || claims["sys"] != auth.SystemInvestigator {
			t.Fatalf("identity claims: %v %v %v", claims["sub"], claims["email"], claims["sys"])
		}
		perms := auth.ParsePermissions(claims["permissions"])
		if len(perms) != 1 || len(perms["default"]) != len(repository.InvestigatorPermissions) {
			t.Fatalf("permissions: %v", perms)
		}
		// The read tools and the one read permission the log store search asks for — never a write.
		for _, p := range perms["default"] {
			if !strings.HasPrefix(p, "ai.tool.") && p != "resource.pod.read" {
				t.Fatalf("unexpected permission %q", p)
			}
		}
		ns := auth.ParseNamespaces(claims["ns"])
		if tc.ns == "" && len(ns) != 0 || tc.ns != "" && (len(ns["default"]) != 1 || ns["default"][0] != tc.ns) {
			t.Fatalf("ns claim for %q: %v", tc.ns, ns)
		}
		exp, _ := claims["exp"].(float64)
		if left := time.Until(time.Unix(int64(exp), 0)); left < 6*time.Minute || left > 7*time.Minute+5*time.Second {
			t.Fatalf("lifetime: %v", left)
		}
	}
}

// The investigator has no user row: its token-version answer is 0 while the
// feature is on and 404 once it is off (validators then refuse the token).
func TestTokenVersion_Investigator(t *testing.T) {
	h, m := investigatorHandler(t, true)
	token, err := m.CreateInvestigatorToken("self", "", repository.ReadAIToolPermissions, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	get := func(h *AuthHandler) *httptest.ResponseRecorder {
		r := chi.NewRouter()
		r.Get("/internal/token-version/{userID}", h.TokenVersion)
		req := httptest.NewRequest(http.MethodGet, "/internal/token-version/system", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	if rec := get(h); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"tv":0}` {
		t.Fatalf("on: got %d %s", rec.Code, rec.Body.String())
	}
	h.cfg.AlertInvestigationEnabled = false
	if rec := get(h); rec.Code != http.StatusNotFound {
		t.Fatalf("off: got %d", rec.Code)
	}
}
