package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

// Long-lived connections. A WebSocket or an event stream is authenticated once, at its first request; the browser
// cannot hand it a new token afterwards, and the token it opened with expires long before an ordinary terminal or
// followed log ends. So a connection is not bound to its token's expiry: it lives as long as the session behind it
// stands. LiveSessions re-asks that on a timer, the way checkTokenVersion does for each request, and ends the
// connection with a cause the client can show.
//
// The token cannot be the credential here (auth-service refuses an expired one, and would read that as revoked), so
// the current version and the signed-out sign-ins come from a VersionLookup that does not need it.

// SessionEndedCloseCode is the close code of a WebSocket ended because its session no longer stands (the application
// range of RFC 6455 §7.4.2); the close reason is one of the Session* codes below.
const SessionEndedCloseCode = 4401

// Why a session ended, as clients are told.
const (
	SessionRevoked    = "session_revoked"    // token_version moved on, or the user or API key is gone
	SessionSignedOut  = "session_signed_out" // the sign-in the connection opened with was signed out
	SessionExpired    = "session_expired"    // past the absolute lifetime since the last sign-in
	SessionUnverified = "session_unverified" // the current version could not be read for too long
)

// SessionEndError is the cancel cause of a held context whose session ended.
type SessionEndError struct{ Code string }

func (e *SessionEndError) Error() string { return "session ended: " + e.Code }

// ErrSubjectGone is what a VersionLookup answers when the user or the API key no longer exists.
var ErrSubjectGone = errors.New("user or API key is gone")

// VersionLookup reads the current token_version and the signed-out sign-ins of a user (SessionStateQuery), and for the
// API key a token was exchanged for whether that key still stands.
type VersionLookup func(ctx context.Context, userID, apiKeyID string) (SessionState, error)

// LiveSessionConfig configures LiveSessions. Zero durations take the defaults; a zero AbsoluteLifetime means no cap.
type LiveSessionConfig struct {
	Lookup           VersionLookup
	AbsoluteLifetime time.Duration
	CheckEvery       time.Duration // default 30s, the validators' TokenVersionCacheTTL
	CacheTTL         time.Duration // default 30s
	StaleTTL         time.Duration // default 5m, how long an unreadable version is tolerated
}

// LiveSessions ends connections whose session stopped standing. A nil *LiveSessions holds nothing.
type LiveSessions struct {
	cfg      LiveSessionConfig
	mu       sync.Mutex
	versions map[string]tokenVersionEntry
}

// NewLiveSessions returns a checker for cfg.
func NewLiveSessions(cfg LiveSessionConfig) *LiveSessions {
	if cfg.CheckEvery <= 0 {
		cfg.CheckEvery = 30 * time.Second
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 30 * time.Second
	}
	if cfg.StaleTTL <= 0 {
		cfg.StaleTTL = 5 * time.Minute
	}
	return &LiveSessions{cfg: cfg, versions: make(map[string]tokenVersionEntry)}
}

// errVersionUnread is a failed lookup: not a verdict on the session.
var errVersionUnread = errors.New("current token version could not be read")

// check says whether the session of payload stands right now. Its version logic is checkTokenVersion's.
func (s *LiveSessions) check(ctx context.Context, p TokenPayload) error {
	now := time.Now()
	// A system token has no user row and cannot be refreshed: its own expiry is all there is.
	if p.System != "" {
		if p.ExpiresAt > 0 && now.Unix() >= p.ExpiresAt {
			return &SessionEndError{Code: SessionExpired}
		}
		return nil
	}
	if s.cfg.AbsoluteLifetime > 0 && p.AuthTime > 0 && now.Sub(time.Unix(p.AuthTime, 0)) > s.cfg.AbsoluteLifetime {
		return &SessionEndError{Code: SessionExpired}
	}
	key := p.UserID
	if p.APIKeyID != "" {
		key = p.UserID + "|" + p.APIKeyID
	}
	s.mu.Lock()
	entry, cached := s.versions[key]
	s.mu.Unlock()
	if cached && now.Sub(entry.fetched) < s.cfg.CacheTTL && p.TokenVersion <= entry.version {
		return liveVerdict(p, entry.state())
	}

	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	current, err := s.cfg.Lookup(lookupCtx, p.UserID, p.APIKeyID)
	switch {
	case err == nil:
		s.remember(key, current, now)
		return liveVerdict(p, current)
	case errors.Is(err, ErrSubjectGone):
		s.mu.Lock()
		delete(s.versions, key)
		s.mu.Unlock()
		return &SessionEndError{Code: SessionRevoked}
	case cached && entry.state().SignedOutAt(p.SignIn()):
		// A sign-out is not undone: what was seen before the outage still ends this one.
		return &SessionEndError{Code: SessionSignedOut}
	case cached && p.TokenVersion < entry.version:
		// Versions only grow: what was seen before the outage still revokes this one.
		return &SessionEndError{Code: SessionRevoked}
	default:
		return fmt.Errorf("%w: %v", errVersionUnread, err)
	}
}

// liveVerdict says whether the session of p stands against state: its sign-in not signed out, its version current.
func liveVerdict(p TokenPayload, state SessionState) error {
	if state.SignedOutAt(p.SignIn()) {
		return &SessionEndError{Code: SessionSignedOut}
	}
	if p.TokenVersion != state.Version {
		return &SessionEndError{Code: SessionRevoked}
	}
	return nil
}

// remember keeps a state and drops the ones past the stale window, so the cache holds the people connected lately.
func (s *LiveSessions) remember(key string, state SessionState, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.versions {
		if now.Sub(e.fetched) > s.cfg.StaleTTL {
			delete(s.versions, k)
		}
	}
	s.versions[key] = tokenVersionEntry{version: state.Version, signedOut: state.SignedOut, fetched: now}
}

// Hold returns a context that ends, with a SessionEndError as its cause, when the session of p stops standing, and the
// function to release it (call it when the connection ends). An unreadable version is tolerated for StaleTTL, so an
// outage of the store does not cut every terminal at once.
func (s *LiveSessions) Hold(ctx context.Context, p TokenPayload) (context.Context, func()) {
	if s == nil || s.cfg.Lookup == nil {
		return ctx, func() {}
	}
	held, cancel := context.WithCancelCause(ctx)
	go s.watch(held, cancel, p)
	return held, func() { cancel(nil) }
}

func (s *LiveSessions) watch(ctx context.Context, end context.CancelCauseFunc, p TokenPayload) {
	// Nothing above this goroutine recovers. A session that cannot be checked does not stand, and the service stays up.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("session check panicked: this connection ends", "panic_type", fmt.Sprintf("%T", r), "stack", string(debug.Stack()))
			end(&SessionEndError{Code: SessionUnverified})
		}
	}()
	ticker := time.NewTicker(s.cfg.CheckEvery)
	defer ticker.Stop()
	verified := time.Now()
	for {
		switch err := s.check(ctx, p); {
		case err == nil:
			verified = time.Now()
		case errors.Is(err, errVersionUnread):
			if ctx.Err() == nil && time.Since(verified) > s.cfg.StaleTTL {
				end(&SessionEndError{Code: SessionUnverified})
				return
			}
		default:
			end(err)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// SessionEndCode is why a held context ended, "" when it was not its session.
func SessionEndCode(ctx context.Context) string {
	var ended *SessionEndError
	if errors.As(context.Cause(ctx), &ended) {
		return ended.Code
	}
	return ""
}
