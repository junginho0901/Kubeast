package auth

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// lookupStub answers a version and signed-out sign-ins that a test can move, or an error.
type lookupStub struct {
	version   atomic.Int32
	signedOut atomic.Value // []int64
	err       atomic.Value // error
	calls     atomic.Int32
	lastKey   atomic.Value // string
}

func (l *lookupStub) lookup(_ context.Context, userID, apiKeyID string) (SessionState, error) {
	l.calls.Add(1)
	l.lastKey.Store(userID + "|" + apiKeyID)
	if e, _ := l.err.Load().(*errBox); e != nil && e.err != nil {
		return SessionState{}, e.err
	}
	out, _ := l.signedOut.Load().([]int64)
	return SessionState{Version: int(l.version.Load()), SignedOut: out}, nil
}

func (l *lookupStub) signOut(authTimes ...int64) { l.signedOut.Store(authTimes) }

type errBox struct{ err error }

func (l *lookupStub) fail(err error) { l.err.Store(&errBox{err}) }

func fastSessions(l *lookupStub, absolute time.Duration) *LiveSessions {
	return NewLiveSessions(LiveSessionConfig{
		Lookup: l.lookup, AbsoluteLifetime: absolute,
		CheckEvery: 5 * time.Millisecond, CacheTTL: time.Millisecond, StaleTTL: 150 * time.Millisecond,
	})
}

func waitEnded(t *testing.T, ctx context.Context) string {
	t.Helper()
	select {
	case <-ctx.Done():
		return SessionEndCode(ctx)
	case <-time.After(3 * time.Second):
		t.Fatal("the held context did not end")
		return ""
	}
}

func stillHeld(t *testing.T, ctx context.Context, d time.Duration) {
	t.Helper()
	select {
	case <-ctx.Done():
		t.Fatalf("the held context ended: %v", context.Cause(ctx))
	case <-time.After(d):
	}
}

func TestAMovedTokenVersionEndsAnOpenConnection(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5})
	defer release()
	stillHeld(t, held, 30*time.Millisecond)
	l.version.Store(6)
	if got := waitEnded(t, held); got != SessionRevoked {
		t.Fatalf("code = %q, want %q", got, SessionRevoked)
	}
}

func TestASignOutEndsAnOpenConnectionOfThatSignInAtItsNextCheck(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	signedIn := time.Now().Add(-time.Hour).Unix()
	held, release := fastSessions(l, 8*time.Hour).Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: signedIn})
	defer release()
	stillHeld(t, held, 30*time.Millisecond)
	l.signOut(signedIn)
	if got := waitEnded(t, held); got != SessionSignedOut {
		t.Fatalf("code = %q, want %q", got, SessionSignedOut)
	}
}

func TestASignOutLeavesTheUsersOtherSignInsAndKeyTokensOpen(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	ended := time.Now().Add(-2 * time.Hour).Unix()
	s := fastSessions(l, 8*time.Hour)
	signedOut, release1 := s.Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: ended})
	defer release1()
	other, release2 := s.Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: ended + 1})
	defer release2()
	// A key's token of the same second is no sign-in.
	key, release3 := s.Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: ended, APIKeyID: "k1"})
	defer release3()
	l.signOut(ended)
	if got := waitEnded(t, signedOut); got != SessionSignedOut {
		t.Fatalf("code = %q, want %q", got, SessionSignedOut)
	}
	stillHeld(t, other, 60*time.Millisecond)
	stillHeld(t, key, time.Millisecond)
}

func TestASignOutSeenBeforeAnOutageStillEndsTheConnection(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	ended := time.Now().Add(-time.Hour).Unix()
	l.signOut(ended)
	s := fastSessions(l, 0)
	if err := s.check(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: ended + 60}); err != nil {
		t.Fatal(err)
	}
	l.fail(errors.New("connection refused"))
	time.Sleep(5 * time.Millisecond)
	err := s.check(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5, AuthTime: ended})
	var gone *SessionEndError
	if !errors.As(err, &gone) || gone.Code != SessionSignedOut {
		t.Fatalf("err = %v, want signed out", err)
	}
}

func TestAGoneUserEndsAnOpenConnection(t *testing.T) {
	l := &lookupStub{}
	l.fail(ErrSubjectGone)
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{UserID: "u1"})
	defer release()
	if got := waitEnded(t, held); got != SessionRevoked {
		t.Fatalf("code = %q, want %q", got, SessionRevoked)
	}
}

func TestAConnectionOutlivesItsTokenWhileTheSessionStands(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	expired := time.Now().Add(-time.Hour).Unix()
	held, release := fastSessions(l, 8*time.Hour).Hold(context.Background(), TokenPayload{
		UserID: "u1", TokenVersion: 5, ExpiresAt: expired, AuthTime: time.Now().Add(-time.Hour).Unix(),
	})
	defer release()
	stillHeld(t, held, 60*time.Millisecond)
	if l.calls.Load() < 2 {
		t.Fatalf("lookups = %d, want it asked again while open", l.calls.Load())
	}
}

func TestTheAbsoluteLifetimeEndsAnOpenConnection(t *testing.T) {
	l := &lookupStub{}
	held, release := fastSessions(l, 8*time.Hour).Hold(context.Background(), TokenPayload{
		UserID: "u1", AuthTime: time.Now().Add(-9 * time.Hour).Unix(),
	})
	defer release()
	if got := waitEnded(t, held); got != SessionExpired {
		t.Fatalf("code = %q, want %q", got, SessionExpired)
	}
}

func TestAConnectionWithNoSignInTimeHasNoAbsoluteLifetime(t *testing.T) {
	l := &lookupStub{}
	held, release := fastSessions(l, time.Millisecond).Hold(context.Background(), TokenPayload{UserID: "u1"})
	defer release()
	stillHeld(t, held, 30*time.Millisecond)
}

func TestNoAbsoluteLifetimeSetLeavesAnOldSessionAlone(t *testing.T) {
	l := &lookupStub{}
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{
		UserID: "u1", AuthTime: time.Now().Add(-1000 * time.Hour).Unix(),
	})
	defer release()
	stillHeld(t, held, 30*time.Millisecond)
}

func TestAnOutageIsToleratedThenEndsTheConnectionAsUnverified(t *testing.T) {
	l := &lookupStub{}
	l.fail(errors.New("connection refused"))
	start := time.Now()
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{UserID: "u1"})
	defer release()
	stillHeld(t, held, 60*time.Millisecond)
	if got := waitEnded(t, held); got != SessionUnverified {
		t.Fatalf("code = %q, want %q", got, SessionUnverified)
	}
	if waited := time.Since(start); waited < 150*time.Millisecond {
		t.Fatalf("ended after %s, inside the stale window", waited)
	}
}

func TestAShortOutageLeavesTheConnectionUp(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(5)
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5})
	defer release()
	stillHeld(t, held, 20*time.Millisecond)
	l.fail(errors.New("connection refused"))
	stillHeld(t, held, 60*time.Millisecond)
	l.fail(nil)
	stillHeld(t, held, 200*time.Millisecond)
}

func TestAVersionSeenBeforeAnOutageStillRevokesAnOlderToken(t *testing.T) {
	l := &lookupStub{}
	l.version.Store(7)
	s := fastSessions(l, 0)
	if err := s.check(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 7}); err != nil {
		t.Fatal(err)
	}
	l.fail(errors.New("connection refused"))
	time.Sleep(5 * time.Millisecond)
	err := s.check(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 6})
	var ended *SessionEndError
	if !errors.As(err, &ended) || ended.Code != SessionRevoked {
		t.Fatalf("err = %v, want revoked", err)
	}
}

func TestOneLookupServesEveryConnectionOfAUserWithinTheCacheWindow(t *testing.T) {
	l := &lookupStub{}
	s := NewLiveSessions(LiveSessionConfig{Lookup: l.lookup, CacheTTL: time.Minute})
	for range 5 {
		if err := s.check(context.Background(), TokenPayload{UserID: "u1"}); err != nil {
			t.Fatal(err)
		}
	}
	if l.calls.Load() != 1 {
		t.Fatalf("lookups = %d, want 1", l.calls.Load())
	}
}

func TestATokenNewerThanTheCachedVersionAsksAgain(t *testing.T) {
	l := &lookupStub{}
	s := NewLiveSessions(LiveSessionConfig{Lookup: l.lookup, CacheTTL: time.Minute})
	if err := s.check(context.Background(), TokenPayload{UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	l.version.Store(1)
	if err := s.check(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 1}); err != nil {
		t.Fatalf("a token issued after the cached answer: %v", err)
	}
}

func TestAnAPIKeysTokenIsAskedWithItsKeyAndCachedApart(t *testing.T) {
	l := &lookupStub{}
	s := NewLiveSessions(LiveSessionConfig{Lookup: l.lookup, CacheTTL: time.Minute})
	if err := s.check(context.Background(), TokenPayload{UserID: "u1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.check(context.Background(), TokenPayload{UserID: "u1", APIKeyID: "k1"}); err != nil {
		t.Fatal(err)
	}
	if l.calls.Load() != 2 || l.lastKey.Load() != "u1|k1" {
		t.Fatalf("calls = %d, last = %v", l.calls.Load(), l.lastKey.Load())
	}
}

func TestASystemTokenEndsAtItsOwnExpiryWithoutALookup(t *testing.T) {
	l := &lookupStub{}
	s := fastSessions(l, 0)
	live := TokenPayload{UserID: "system", System: SystemInvestigator, ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if err := s.check(context.Background(), live); err != nil {
		t.Fatal(err)
	}
	held, release := s.Hold(context.Background(), TokenPayload{UserID: "system", System: SystemInvestigator, ExpiresAt: time.Now().Add(-time.Second).Unix()})
	defer release()
	if got := waitEnded(t, held); got != SessionExpired {
		t.Fatalf("code = %q, want %q", got, SessionExpired)
	}
	if l.calls.Load() != 0 {
		t.Fatalf("lookups = %d", l.calls.Load())
	}
}

func TestReleasingAConnectionIsNotASessionEnd(t *testing.T) {
	l := &lookupStub{}
	held, release := fastSessions(l, 0).Hold(context.Background(), TokenPayload{UserID: "u1"})
	release()
	if got := waitEnded(t, held); got != "" {
		t.Fatalf("code = %q, want none", got)
	}
}

func TestNoCheckerHoldsNothing(t *testing.T) {
	var s *LiveSessions
	ctx := context.Background()
	held, release := s.Hold(ctx, TokenPayload{UserID: "u1"})
	defer release()
	if held != ctx {
		t.Fatal("a nil checker changed the context")
	}
}

func TestTheVersionCacheForgetsPeopleGoneLongAgo(t *testing.T) {
	l := &lookupStub{}
	s := fastSessions(l, 0)
	_ = s.check(context.Background(), TokenPayload{UserID: "old"})
	time.Sleep(200 * time.Millisecond)
	_ = s.check(context.Background(), TokenPayload{UserID: "new"})
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.versions["old"]; ok || len(s.versions) != 1 {
		t.Fatalf("cache = %v", s.versions)
	}
}

func TestValidateCarriesTheTokensExpiry(t *testing.T) {
	js := newJWKSServer(t, "k1")
	v := NewJWTValidator(JWKSConfig{JWKSURL: js.srv.URL, Issuer: "iss", Audience: "aud"})
	exp := time.Now().Add(time.Hour).Unix()
	p, err := v.Validate(signClaims(t, js.key, "k1", jwt.MapClaims{"exp": exp}))
	if err != nil {
		t.Fatal(err)
	}
	if p.ExpiresAt != exp {
		t.Fatalf("ExpiresAt = %d, want %d", p.ExpiresAt, exp)
	}
}

// Nothing above the check's goroutine recovers: a panic there ends the connection it holds and not the service.
func TestAPanicInTheSessionCheckEndsThatConnection(t *testing.T) {
	s := NewLiveSessions(LiveSessionConfig{
		Lookup:     func(context.Context, string, string) (SessionState, error) { panic("the store answered nonsense") },
		CheckEvery: 5 * time.Millisecond, CacheTTL: time.Millisecond, StaleTTL: 150 * time.Millisecond,
	})
	held, release := s.Hold(context.Background(), TokenPayload{UserID: "u1", TokenVersion: 5})
	defer release()
	if got := waitEnded(t, held); got != SessionUnverified {
		t.Fatalf("code = %q, want %q", got, SessionUnverified)
	}
}
