package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// jwksServer serves the JWKS of whichever key is currently "active" and counts
// fetches, standing in for auth-service across a restart.
type jwksServer struct {
	mu      sync.Mutex
	kid     string
	key     *rsa.PrivateKey
	fetches atomic.Int32
	srv     *httptest.Server
}

func newJWKSServer(t *testing.T, kid string) *jwksServer {
	t.Helper()
	s := &jwksServer{kid: kid, key: genKey(t)}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.fetches.Add(1)
		s.mu.Lock()
		defer s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": s.kid, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(s.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(s.key.E)).Bytes()),
		}}})
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *jwksServer) rotate(t *testing.T, kid string) *rsa.PrivateKey {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kid, s.key = kid, genKey(t)
	return s.key
}

func genKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func sign(t *testing.T, key *rsa.PrivateKey, kid string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "u1", "email": "u1@example.com", "role": "admin",
		"permissions": map[string][]string{"*": {"*"}},
		"iss":         "iss", "aud": "aud",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newValidator(s *jwksServer) *JWTValidator {
	return NewJWTValidator(JWKSConfig{JWKSURL: s.srv.URL, Issuer: "iss", Audience: "aud"})
}

// signClaims signs a token with the given extra/overriding claims.
func signClaims(t *testing.T, key *rsa.PrivateKey, kid string, extra jwt.MapClaims) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "u1", "email": "u1@example.com", "role": "admin",
		"permissions": map[string][]string{"*": {"*"}},
		"iss":         "iss", "aud": "aud",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	}
	for k, v := range extra {
		claims[k] = v
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestValidate_AuthTimeClaimFallsBackToIat(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	iat := time.Now().Add(-2 * time.Hour).Unix()
	p, err := v.Validate(signClaims(t, s.key, "kid-a", jwt.MapClaims{"iat": iat}))
	if err != nil {
		t.Fatal(err)
	}
	if p.AuthTime != iat {
		t.Fatalf("auth_time missing → iat expected %d, got %d", iat, p.AuthTime)
	}
	at := time.Now().Add(-5 * time.Hour).Unix()
	p, err = v.Validate(signClaims(t, s.key, "kid-a", jwt.MapClaims{"auth_time": at}))
	if err != nil {
		t.Fatal(err)
	}
	if p.AuthTime != at {
		t.Fatalf("auth_time expected %d, got %d", at, p.AuthTime)
	}
}

func TestMiddleware_PendingRoleIsScoped(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	pending := signClaims(t, s.key, "kid-a", jwt.MapClaims{"role": "Pending", "permissions": map[string][]string{}})
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := v.Middleware(next)
	for path, want := range map[string]int{
		"/api/v1/auth/me":              http.StatusNoContent,
		"/api/v1/auth/refresh":         http.StatusNoContent,
		"/api/v1/auth/change-password": http.StatusNoContent,
		"/api/v1/sessions":             http.StatusForbidden,
		"/api/v1/audit/cluster-switch": http.StatusForbidden,
		"/api/v1/pods":                 http.StatusForbidden,
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+pending)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("pending → %s: got %d, want %d", path, rec.Code, want)
		}
	}
	// a granted role is not affected
	req := httptest.NewRequest(http.MethodGet, "/api/v1/pods", nil)
	req.Header.Set("Authorization", "Bearer "+sign(t, s.key, "kid-a"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin → /api/v1/pods: got %d", rec.Code)
	}
}

func TestValidate_RotatedKeyNewKidIsFetched(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	if _, err := v.Validate(sign(t, s.key, "kid-a")); err != nil {
		t.Fatalf("first token: %v", err)
	}
	keyB := s.rotate(t, "kid-b")
	v.mu.Lock()
	v.lastFetch = time.Time{} // outside the refetch throttle window
	v.mu.Unlock()
	if _, err := v.Validate(sign(t, keyB, "kid-b")); err != nil {
		t.Fatalf("token with new kid after rotation: %v", err)
	}
}

func TestValidate_RotatedKeySameKidRefetchesOnSignatureFailure(t *testing.T) {
	s := newJWKSServer(t, "kid-fixed")
	v := newValidator(s)
	if _, err := v.Validate(sign(t, s.key, "kid-fixed")); err != nil {
		t.Fatalf("first token: %v", err)
	}
	keyB := s.rotate(t, "kid-fixed")
	v.mu.Lock()
	v.lastFetch = time.Time{}
	v.mu.Unlock()
	before := s.fetches.Load()
	if _, err := v.Validate(sign(t, keyB, "kid-fixed")); err != nil {
		t.Fatalf("token signed by rotated key (same kid) must validate after refetch: %v", err)
	}
	if s.fetches.Load() != before+1 {
		t.Fatalf("expected exactly one refetch, got %d", s.fetches.Load()-before)
	}
}

func TestValidate_RefetchIsRateLimited(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	if _, err := v.Validate(sign(t, s.key, "kid-a")); err != nil {
		t.Fatalf("first token: %v", err)
	}
	before := s.fetches.Load()
	other := genKey(t)
	for i := 0; i < 5; i++ {
		if _, err := v.Validate(sign(t, other, "kid-a")); err == nil {
			t.Fatal("token signed by a foreign key must be rejected")
		}
		if _, err := v.Validate(sign(t, other, "kid-unknown")); err == nil {
			t.Fatal("unknown kid must be rejected")
		}
	}
	if s.fetches.Load() != before {
		t.Fatalf("bad tokens inside the throttle window must not refetch, got %d fetches", s.fetches.Load()-before)
	}
}

func TestMiddleware_CookieAuthNeedsCSRFHeaderForWrites(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	tok := sign(t, s.key, "kid-a")
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mw := v.MiddlewareWithCookie("kubeast.token", ok)

	do := func(method string, cookie, bearer, xrw bool) int {
		req := httptest.NewRequest(method, "/api/v1/namespaces", nil)
		if cookie {
			req.AddCookie(&http.Cookie{Name: "kubeast.token", Value: tok})
		}
		if bearer {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		if xrw {
			req.Header.Set(CSRFHeader, CSRFHeaderValue)
		}
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		return rec.Code
	}
	if got := do("GET", true, false, false); got != 200 {
		t.Fatalf("cookie GET without header: %d", got)
	}
	if got := do("POST", true, false, false); got != 403 {
		t.Fatalf("cookie POST without X-Requested-With must be 403, got %d", got)
	}
	if got := do("POST", true, false, true); got != 200 {
		t.Fatalf("cookie POST with X-Requested-With: %d", got)
	}
	if got := do("DELETE", false, true, false); got != 200 {
		t.Fatalf("bearer DELETE needs no CSRF header (API client): %d", got)
	}
	if got := do("POST", false, false, true); got != 401 {
		t.Fatalf("no credential: %d", got)
	}
}

func TestValidate_ForeignKeyStillRejectedAfterRefetch(t *testing.T) {
	s := newJWKSServer(t, "kid-a")
	v := newValidator(s)
	v.mu.Lock()
	v.lastFetch = time.Time{}
	v.mu.Unlock()
	other := genKey(t)
	if _, err := v.Validate(sign(t, other, "kid-a")); err == nil {
		t.Fatal("foreign key must be rejected even when a refetch is allowed")
	}
}
