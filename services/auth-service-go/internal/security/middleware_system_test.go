package security

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const readTool = "ai.tool.clusters_list"

func serve(mw func(http.Handler) http.Handler, req *http.Request) (*httptest.ResponseRecorder, *auth.TokenPayload) {
	var seen *auth.TokenPayload
	w := httptest.NewRecorder()
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := auth.FromContext(r.Context()); ok {
			seen = &p
		}
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(w, req)
	return w, seen
}

func withBearer(token string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func systemClaims(sub, sys string) jwt.MapClaims {
	return jwt.MapClaims{
		"sub": sub, "sys": sys, "email": auth.UserInvestigator, "role": "read",
		"permissions": map[string]any{"a": []string{readTool}},
		"iss":         "iss", "aud": "aud", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	}
}

// Every other route stops a system token before any account is looked up, so the
// boundary does not rest on no account having that subject.
func TestAuthMiddleware_RefusesASystemToken(t *testing.T) {
	m := newTestManager(t)
	tok, err := m.CreateInvestigatorToken("a", "", []string{readTool}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	asked := false
	lookup := func(context.Context, string, string) (int, error) {
		asked = true
		return 0, nil
	}
	w, seen := serve(AuthMiddleware(m, lookup, "kubeast.token"), withBearer(tok))
	if w.Code != http.StatusForbidden || seen != nil {
		t.Errorf("%d %s, handler reached = %v, want 403 and no handler", w.Code, w.Body.String(), seen != nil)
	}
	if asked {
		t.Error("an account was looked up for it")
	}
}

func TestInvestigatorReadMiddleware(t *testing.T) {
	m := newTestManager(t)
	other := newTestManager(t)
	investigator, err := m.CreateInvestigatorToken("a", "team-a", []string{readTool}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := m.CreateInvestigatorToken("a", "", []string{readTool}, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	fromAnotherKey, err := other.CreateInvestigatorToken("a", "", []string{readTool}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	person, err := m.CreateToken("u1", "u1@example.com", "Member", auth.PermissionMatrix{"a": {readTool}}, nil, nil, 3)
	if err != nil {
		t.Fatal(err)
	}
	stalePerson, err := m.CreateToken("u1", "u1@example.com", "Member", auth.PermissionMatrix{"a": {readTool}}, nil, nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	goneAccount, err := m.CreateToken("gone", "gone@example.com", "Member", auth.PermissionMatrix{"a": {readTool}}, nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(_ context.Context, userID, _ string) (int, error) {
		if userID != "u1" {
			return 0, errors.New("no such user")
		}
		return 3, nil
	}
	inCookie := httptest.NewRequest(http.MethodGet, "/api/v1/clusters", nil)
	inCookie.AddCookie(&http.Cookie{Name: "kubeast.token", Value: investigator})

	for _, c := range []struct {
		name       string
		req        *http.Request
		enabled    bool
		want       int
		wantSystem string
	}{
		{"the investigator's token", withBearer(investigator), true, http.StatusOK, auth.SystemInvestigator},
		{"with investigation off", withBearer(investigator), false, http.StatusForbidden, ""},
		{"from the session cookie", inCookie, true, http.StatusForbidden, ""},
		{"another kind of system token", withBearer(signed(t, m, systemClaims(InvestigatorSubject, "other"))), true, http.StatusForbidden, ""},
		{"the claim on another subject", withBearer(signed(t, m, systemClaims("u1", auth.SystemInvestigator))), true, http.StatusForbidden, ""},
		{"signed with another key", withBearer(fromAnotherKey), true, http.StatusUnauthorized, ""},
		{"expired", withBearer(expired), true, http.StatusUnauthorized, ""},
		{"a person at their current version", withBearer(person), true, http.StatusOK, ""},
		{"a person at an old version", withBearer(stalePerson), true, http.StatusUnauthorized, ""},
		{"an account that is gone", withBearer(goneAccount), true, http.StatusUnauthorized, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			w, seen := serve(InvestigatorReadMiddleware(m, lookup, "kubeast.token", c.enabled), c.req)
			if w.Code != c.want {
				t.Fatalf("%d %s, want %d", w.Code, w.Body.String(), c.want)
			}
			if (seen != nil) != (c.want == http.StatusOK) {
				t.Fatalf("handler reached = %v with status %d", seen != nil, w.Code)
			}
			if seen != nil && seen.System != c.wantSystem {
				t.Errorf("System = %q, want %q", seen.System, c.wantSystem)
			}
		})
	}
}

// What the investigator's token holds reaches the handler as the token says it.
func TestInvestigatorReadMiddleware_KeepsTheTokensLimits(t *testing.T) {
	m := newTestManager(t)
	tok, err := m.CreateInvestigatorToken("a", "team-a", []string{readTool}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(context.Context, string, string) (int, error) { return 0, errors.New("no such user") }
	w, seen := serve(InvestigatorReadMiddleware(m, lookup, "kubeast.token", true), withBearer(tok))
	if w.Code != http.StatusOK || seen == nil {
		t.Fatalf("%d %s, want 200", w.Code, w.Body.String())
	}
	if seen.UserID != InvestigatorSubject || seen.HasPermission(readTool) || !seen.HasPermissionForCluster(readTool, "a") || seen.HasPermissionForCluster(readTool, "b") {
		t.Errorf("payload = %+v, want the subject and the tool on cluster a only", *seen)
	}
	if got := seen.Namespaces["a"]; len(got) != 1 || got[0] != "team-a" {
		t.Errorf("namespaces = %v, want team-a", seen.Namespaces)
	}
}
