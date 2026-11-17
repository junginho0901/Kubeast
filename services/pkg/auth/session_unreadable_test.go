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
