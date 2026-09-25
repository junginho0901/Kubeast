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
