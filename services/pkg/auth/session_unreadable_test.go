package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// What a service answers when auth-service could not read a token's session (its database restarting): auth-service
// answers 503, and a service with nothing cached refuses with 503 and Retry-After, never with the 401 that signs the
// console out. A user or key that is gone (404) and a version that moved on stay 401.
func TestMiddleware_ASessionThatCannotBeReadIsRefusedWith503NotSignedOut(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	v := newTVValidator(j, tv, time.Millisecond, 5*time.Minute)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mw := v.MiddlewareWithCookie("kubeast.token", ok)
	call := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces", nil)
		req.AddCookie(&http.Cookie{Name: "kubeast.token", Value: token})
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, req)
		return rec
	}

	// Nothing cached for this user, and auth-service could not read the version.
	tv.status.Store(http.StatusServiceUnavailable)
	rec := call(signWithTV(t, j.key, "k1", 3))
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != strconv.Itoa(SessionUnreadableRetryAfter) {
		t.Fatalf("unreadable session = %d (Retry-After %q) %s, want 503 with Retry-After", rec.Code, rec.Header().Get("Retry-After"), rec.Body)
	}
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); !errors.Is(err, ErrSessionUnreadable) || errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("Validate = %v, want ErrSessionUnreadable and not revoked", err)
	}

	// auth-service read it again: the same token passes, nothing was revoked meanwhile.
	tv.status.Store(0)
	if rec := call(signWithTV(t, j.key, "k1", 3)); rec.Code != http.StatusOK {
		t.Fatalf("after the outage = %d, want 200", rec.Code)
	}

	// A version that moved on and a user who is gone stay 401.
	time.Sleep(2 * time.Millisecond)
	if rec := call(signWithTV(t, j.key, "k1", 2)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("older version = %d, want 401", rec.Code)
	}
	tv.status.Store(http.StatusNotFound)
	time.Sleep(2 * time.Millisecond)
	if rec := call(signWithTV(t, j.key, "k1", 3)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("user gone = %d, want 401", rec.Code)
	}
}

func TestReadFailedIsEveryErrorButAGoneSubject(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{nil, false},
		{ErrSubjectGone, false},
		{fmt.Errorf("%w: no rows in result set", ErrSubjectGone), false},
		{errors.New("dial tcp 10.0.0.5:5432: connect: connection refused"), true},
		{errors.New("context deadline exceeded"), true},
	} {
		if got := ReadFailed(tc.err); got != tc.want {
			t.Errorf("ReadFailed(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestSessionEndCloseCodeLetsAnUncheckedSessionConnectAgain(t *testing.T) {
	for reason, want := range map[string]int{
		SessionUnverified: SessionRetryCloseCode,
		SessionRevoked:    SessionEndedCloseCode,
		SessionSignedOut:  SessionEndedCloseCode,
		SessionExpired:    SessionEndedCloseCode,
	} {
		if got := SessionEndCloseCode(reason); got != want {
			t.Errorf("SessionEndCloseCode(%q) = %d, want %d", reason, got, want)
		}
	}
}

// While auth-service cannot read a user's version, that user's requests within TokenVersionFailurePause get the
// failure's answer without asking again; other users still ask, and the first ask after the pause reads a revocation
// at once. A version seen older before the outage stays refused during the pause.
func TestValidate_AFailedLookupIsNotAskedAgainWithinThePause(t *testing.T) {
	j := newJWKSServer(t, "k1")
	tv := newTVServer(t, 3)
	const pause = 150 * time.Millisecond
	v := NewJWTValidator(JWKSConfig{JWKSURL: j.srv.URL, Issuer: "iss", Audience: "aud", TokenVersionURL: tv.srv.URL,
		TokenVersionCacheTTL: time.Millisecond, TokenVersionStaleTTL: time.Minute, TokenVersionFailurePause: pause})
	u2 := func(tvClaim int) string {
		return signClaims(t, j.key, "k1", map[string]any{"sub": "u2", "tv": tvClaim})
	}

	// u1 read once, then auth-service cannot read its database
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); err != nil {
		t.Fatalf("prime: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	tv.status.Store(http.StatusServiceUnavailable)
	before := tv.calls.Load()
	for i := 0; i < 5; i++ {
		if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); err != nil {
			t.Fatalf("u1 bridged from its version read before: %v", err)
		}
	}
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 2)); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("a version older than the one read before, in the pause: %v, want revoked", err)
	}
	if got := tv.calls.Load() - before; got != 1 {
		t.Fatalf("u1 asked auth-service %d times within the pause, want 1", got)
	}

	// another user is asked for, once, and refused as unreadable for its pause
	for i := 0; i < 3; i++ {
		if _, err := v.Validate(u2(0)); !errors.Is(err, ErrSessionUnreadable) {
			t.Fatalf("u2 never read: %v, want unreadable", err)
		}
	}
	if got := tv.calls.Load() - before; got != 2 {
		t.Fatalf("asks = %d, want one more for u2", got)
	}

	// after the pause: the next request asks, and a revocation is read at once
	time.Sleep(pause + 20*time.Millisecond)
	tv.status.Store(http.StatusNotFound)
	if _, err := v.Validate(signWithTV(t, j.key, "k1", 3)); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("after the pause, a user gone: %v, want revoked", err)
	}
	if got := tv.calls.Load() - before; got != 3 {
		t.Fatalf("asks = %d, want one more after the pause", got)
	}
}
