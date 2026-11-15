package auth

import (
	"crypto/rsa"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
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
	srv       *httptest.Server
	version   atomic.Int32
	signedOut atomic.Value // string: the JSON list, "" for an answer without the field (an older auth-service)
	status    atomic.Int32 // 0 = 200 with the version
	calls     atomic.Int32
	lastSub   string
	lastTok   string
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
		body := `{"tv":` + strconv.Itoa(int(s.version.Load()))
		if list, _ := s.signedOut.Load().(string); list != "" {
			body += `,"signed_out":` + list
		}
		_, _ = w.Write([]byte(body + `}`))
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// signInToken is a sign-in's token of u1 at version tv, signed in at authTime; akid makes it a key's token instead.
func signInToken(t *testing.T, j *jwksServer, tv int, authTime int64, akid string) string {
	t.Helper()
	extra := jwt.MapClaims{"tv": tv, "auth_time": authTime}
	if akid != "" {
		extra["akid"] = akid
	}
	return signClaims(t, j.key, "k1", extra)
}

func TestValidate_ASignedOutSignInIsRefusedAndTheUsersOthersPass(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	signedIn := time.Now().Add(-time.Hour).Unix()
	tv.signedOut.Store("[" + strconv.FormatInt(signedIn, 10) + "]")
	v := newTVValidator(j, tv, 30*time.Second, 5*time.Minute)

	if _, err := v.Validate(signInToken(t, j, 3, signedIn+1, "")); err != nil {
		t.Fatalf("another sign-in of the user: %v", err)
	}
	if _, err := v.Validate(signInToken(t, j, 3, signedIn, "")); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("the signed-out sign-in: %v", err)
	}
	if tv.calls.Load() != 1 {
		t.Fatalf("lookups = %d: one answer serves every sign-in of the user", tv.calls.Load())
	}
	if _, err := v.Validate(signInToken(t, j, 3, signedIn, "key-1")); err != nil {
		t.Fatalf("a key's token of the same second is no sign-in: %v", err)
	}
}

func TestValidate_ASignOutSeenBeforeAnOutageStaysRefused(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	signedIn := time.Now().Add(-time.Hour).Unix()
	tv.signedOut.Store("[" + strconv.FormatInt(signedIn, 10) + "]")
	v := newTVValidator(j, tv, time.Millisecond, 5*time.Minute)
	other := signInToken(t, j, 3, signedIn+1, "")
	if _, err := v.Validate(other); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	tv.status.Store(http.StatusBadGateway)
	if _, err := v.Validate(signInToken(t, j, 3, signedIn, "")); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("signed out before the outage: %v", err)
	}
	if _, err := v.Validate(other); err != nil {
		t.Fatalf("the other sign-in is bridged as before: %v", err)
	}
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

// A token an API key was exchanged for is cached apart from the user's sign-in token: once auth-service answers
// "revoked" for it (the key was deleted), the user's sign-in token checking in keeps passing but cannot refresh an
// entry the key's token would ride on.
func TestValidate_TokenVersionKeyTokenCachedApart(t *testing.T) {
	j := newJWKSServer(t, "k1")
	revokedKey := atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, _ := jwt.Parse(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), func(*jwt.Token) (any, error) { return &j.key.PublicKey, nil })
		if claims, ok := tok.Claims.(jwt.MapClaims); ok && claims["akid"] != nil && revokedKey.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"tv":3}`))
	}))
	t.Cleanup(srv.Close)
	v := NewJWTValidator(JWKSConfig{JWKSURL: j.srv.URL, Issuer: "iss", Audience: "aud", TokenVersionURL: srv.URL,
		TokenVersionCacheTTL: 50 * time.Millisecond, TokenVersionStaleTTL: time.Minute})
	signIn := signWithTV(t, j.key, "k1", 3)
	keyTok := func() string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"sub": "u1", "email": "u1@example.com", "role": "admin", "akid": "key-1",
			"permissions": map[string][]string{"*": {"*"}}, "iss": "iss", "aud": "aud", "tv": 3,
			"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
		})
		tok.Header["kid"] = "k1"
		s, _ := tok.SignedString(j.key)
		return s
	}()
	if _, err := v.Validate(keyTok); err != nil {
		t.Fatalf("live key token: %v", err)
	}
	revokedKey.Store(true)
	time.Sleep(60 * time.Millisecond) // the key token's entry is due; the sign-in token now refreshes its own
	if _, err := v.Validate(signIn); err != nil {
		t.Fatalf("sign-in token after the key went: %v", err)
	}
	if _, err := v.Validate(keyTok); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("key token after revocation must be refused, got %v", err)
	}
}

// slowTVServer answers the token-version lookup after a pause, refusing the tokens refuse names, and counts the asks
// per token.
func slowTVServer(t *testing.T, pause time.Duration, refuse func(token string) bool) (*httptest.Server, func(token string) int) {
	t.Helper()
	var mu sync.Mutex
	asks := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		mu.Lock()
		asks[tok]++
		mu.Unlock()
		time.Sleep(pause)
		if refuse != nil && refuse(tok) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"tv":3}`))
	}))
	t.Cleanup(srv.Close)
	return srv, func(token string) int {
		mu.Lock()
		defer mu.Unlock()
		return asks[token]
	}
}

func signSession(t *testing.T, key *rsa.PrivateKey, session string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "u1", "email": "u1@example.com", "role": "admin", "sid": session,
		"permissions": map[string][]string{"*": {"*"}}, "iss": "iss", "aud": "aud", "tv": 3,
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	})
	tok.Header["kid"] = "k1"
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The reads one screen sends together with one token ask auth-service the token's version once, and all pass.
func TestValidate_RequestsOfOneTokenAtOnceAskTheVersionOnce(t *testing.T) {
	j := newJWKSServer(t, "k1")
	srv, asks := slowTVServer(t, 50*time.Millisecond, nil)
	v := NewJWTValidator(JWKSConfig{JWKSURL: j.srv.URL, Issuer: "iss", Audience: "aud", TokenVersionURL: srv.URL})
	token := signSession(t, j.key, "screen")
	if err := v.fetchKeys(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var failed atomic.Int32
	for i := 0; i < 11; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := v.Validate(token); err != nil {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if n := failed.Load(); n != 0 {
		t.Errorf("%d of 11 requests of a current token were refused", n)
	}
	if n := asks(token); n != 1 {
		t.Errorf("11 requests at once asked auth-service %d times, want 1", n)
	}
}

// Two tokens of one user asked at the same moment each get auth-service's own answer: one refused does not refuse
// the other.
func TestValidate_ARefusedTokenDoesNotRefuseAnotherTokenOfTheUserAskedAtOnce(t *testing.T) {
	j := newJWKSServer(t, "k1")
	gone := signSession(t, j.key, "gone")
	live := signSession(t, j.key, "live")
	srv, asks := slowTVServer(t, 50*time.Millisecond, func(tok string) bool { return tok == gone })
	v := NewJWTValidator(JWKSConfig{JWKSURL: j.srv.URL, Issuer: "iss", Audience: "aud", TokenVersionURL: srv.URL})
	if err := v.fetchKeys(); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var goneErr, liveErr error
	wg.Add(2)
	go func() { defer wg.Done(); _, goneErr = v.Validate(gone) }()
	go func() { defer wg.Done(); time.Sleep(10 * time.Millisecond); _, liveErr = v.Validate(live) }()
	wg.Wait()
	if !errors.Is(goneErr, ErrTokenRevoked) {
		t.Errorf("the refused token: %v, want revoked", goneErr)
	}
	if liveErr != nil {
		t.Errorf("the live token asked at the same moment: %v", liveErr)
	}
	if asks(gone) != 1 || asks(live) != 1 {
		t.Errorf("asks gone=%d live=%d, want 1 each", asks(gone), asks(live))
	}
}
