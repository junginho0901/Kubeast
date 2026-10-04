package security

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A pending account's token opens only the self-service paths (L15).
func TestAuthMiddleware_PendingRoleIsScoped(t *testing.T) {
	m := newTestManager(t)
	tok, _ := m.CreateToken("u1", "u1@example.com", "Pending", auth.PermissionMatrix{"*": {}}, nil, 1)
	mw := AuthMiddleware(m, nil, "kubeast.token")
	for path, want := range map[string]int{
		"/api/v1/auth/me":              http.StatusOK,
		"/api/v1/auth/refresh":         http.StatusOK,
		"/api/v1/auth/change-password": http.StatusOK,
		"/api/v1/audit/cluster-switch": http.StatusForbidden,
		"/api/v1/clusters":             http.StatusForbidden,
		"/api/v1/auth/admin/users":     http.StatusForbidden,
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })).ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("pending → %s: got %d, want %d", path, rec.Code, want)
		}
	}
}

// auth_time reaches the handler (Refresh enforces the absolute lifetime from it)
// and is carried through CreateTokenAt unchanged.
func TestAuthMiddleware_AuthTimeIsCarried(t *testing.T) {
	m := newTestManager(t)
	signedIn := time.Now().Add(-3 * time.Hour).Truncate(time.Second)
	tok, err := m.CreateTokenAt("u1", "u1@example.com", "admin", auth.PermissionMatrix{"*": {"*"}}, nil, 1, signedIn)
	if err != nil {
		t.Fatal(err)
	}
	mw := AuthMiddleware(m, nil, "kubeast.token")
	var got int64
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.FromContext(r.Context())
		got = p.AuthTime
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || got != signedIn.Unix() {
		t.Fatalf("auth_time: code %d, got %d want %d", rec.Code, got, signedIn.Unix())
	}

	// a token without auth_time (CreateToken) counts from now (iat)
	fresh, _ := m.CreateToken("u1", "u1@example.com", "admin", auth.PermissionMatrix{"*": {"*"}}, nil, 1)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+fresh)
	mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.FromContext(r.Context())
		got = p.AuthTime
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(rec, req)
	if time.Since(time.Unix(got, 0)) > time.Minute {
		t.Fatalf("fresh token auth_time should be about now, got %d", got)
	}
}
