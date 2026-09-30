package auth

import (
	"crypto/rsa"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func signWithTV(t *testing.T, key *rsa.PrivateKey, kid string, tv int) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "u1", "email": "u1@example.com", "role": "admin",
		"permissions": map[string][]string{"*": {"*"}},
		"iss":         "iss", "aud": "aud", "tv": tv,
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// tvServer stands in for auth-service's token-version lookup.
type tvServer struct {
	srv     *httptest.Server
	version atomic.Int32
	status  atomic.Int32 // 0 = 200 with the version
	calls   atomic.Int32
	lastSub string
	lastTok string
}

func newTVServer(t *testing.T, version int) *tvServer {
	t.Helper()
	s := &tvServer{}
	s.version.Store(int32(version))
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		s.lastSub = strings.TrimPrefix(r.URL.Path, "/")
		s.lastTok = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if st := s.status.Load(); st != 0 {
			w.WriteHeader(int(st))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tv":` + strconv.Itoa(int(s.version.Load())) + `}`))
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func newTVValidator(j *jwksServer, tv *tvServer, cacheTTL, staleTTL time.Duration) *JWTValidator {
	return NewJWTValidator(JWKSConfig{
		JWKSURL: j.srv.URL, Issuer: "iss", Audience: "aud",
		TokenVersionURL: tv.srv.URL, TokenVersionCacheTTL: cacheTTL, TokenVersionStaleTTL: staleTTL,
	})
}

func TestValidate_TokenVersionChecked(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	v := newTVValidator(j, tv, 30*time.Second, 5*time.Minute)
	token := signWithTV(t, j.key, "k1", 3)

	p, err := v.Validate(token)
	if err != nil || p.TokenVersion != 3 {
		t.Fatalf("current version must pass: %v (payload %+v)", err, p)
	}
	if tv.lastSub != "u1" || tv.lastTok != token {
		t.Fatalf("lookup must be for the token's own subject with the token as credential: sub=%q", tv.lastSub)
	}
	// Second call inside the cache TTL does not ask again.
	if _, err := v.Validate(token); err != nil || tv.calls.Load() != 1 {
		t.Fatalf("cached: err=%v calls=%d", err, tv.calls.Load())
	}
	// The user's version moved on (role change): the old token is refused
	// once the cache expires.
	tv.version.Store(4)
	v2 := newTVValidator(j, tv, 30*time.Second, 5*time.Minute)
	if _, err := v2.Validate(token); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("bumped version must revoke: %v", err)
	}
	// A token carrying the new version passes.
	if _, err := v2.Validate(signWithTV(t, j.key, "k1", 4)); err != nil {
		t.Fatalf("token with the current version: %v", err)
	}
}

func TestValidate_TokenVersionNewerTokenRefreshesCache(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	v := newTVValidator(j, tv, 30*time.Second, 5*time.Minute)
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); err != nil {
		t.Fatalf("prime cache at 3: %v", err)
	}
	// Role change + sign-in again inside the cache window: the new token
	// (tv 4) must work at once, and the old one (tv 3) must stop.
	tv.version.Store(4)
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 4)); err != nil {
		t.Fatalf("newer token must refetch instead of failing against the cache: %v", err)
	}
	if tv.calls.Load() != 2 {
		t.Fatalf("expected a refetch, calls=%d", tv.calls.Load())
	}
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("old token after the refetch: %v", err)
	}
	// A token ahead of what auth-service reports is not trusted either.
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 9)); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("token ahead of the current version: %v", err)
	}
}

func TestValidate_TokenVersionUnavailable(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 1)
	token := signWithTV(t, j.key, "k1", 1)

	// Nothing cached and auth-service down: refuse.
	v := newTVValidator(j, tv, time.Millisecond, 5*time.Minute)
	tv.status.Store(http.StatusBadGateway)
	if _, err := v.Validate(token); err == nil || errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("no cache + unreachable must fail closed (not as revoked): %v", err)
	}
	// Cached earlier, then auth-service down: the stale value still counts.
	tv.status.Store(0)
	if _, err := v.Validate(token); err != nil {
		t.Fatalf("prime cache: %v", err)
	}
	time.Sleep(2 * time.Millisecond) // past the cache TTL, inside the stale TTL
	tv.status.Store(http.StatusInternalServerError)
	if _, err := v.Validate(token); err != nil {
		t.Fatalf("stale cache must bridge an outage: %v", err)
	}
	// Past the stale TTL as well: refuse.
	vShort := newTVValidator(j, tv, time.Millisecond, 2*time.Millisecond)
	tv.status.Store(0)
	if _, err := vShort.Validate(token); err != nil {
		t.Fatalf("prime: %v", err)
	}
	time.Sleep(3 * time.Millisecond)
	tv.status.Store(http.StatusInternalServerError)
	if _, err := vShort.Validate(token); err == nil {
		t.Fatal("beyond the stale TTL an outage must fail closed")
	}
	// A deleted user (404) is revoked at once, not bridged.
	tv.status.Store(http.StatusNotFound)
	vNone := newTVValidator(j, tv, 30*time.Second, 5*time.Minute)
	if _, err := vNone.Validate(token); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("404 must count as revoked: %v", err)
	}
}

func TestValidate_TokenVersionOffWithoutURL(t *testing.T) {
	j := newJWKSServer(t, "k1")
	v := newValidator(j) // no TokenVersionURL
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 99)); err != nil {
		t.Fatalf("without a lookup URL the claim is carried but not checked: %v", err)
	}
}
