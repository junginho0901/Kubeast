package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"
)

// Token revocation. auth-service keeps a token_version per user and bumps it
// when a role or cluster grant changes, a password is reset or the user
// signs out everywhere; tokens carry the version they were issued with as
// "tv". A sign-out ends one sign-in: auth-service keeps the user and the
// auth_time its tokens carry in ended_sign_ins. auth-service checks both on
// its own routes; every other service reads them from auth-service here, in
// the same answer, so a revoked or signed-out token stops working within
// TokenVersionCacheTTL instead of at expiry.

// ErrTokenRevoked is returned when the token's "tv" is behind the user's
// current token_version, its sign-in was signed out, or the user no longer
// exists.
var ErrTokenRevoked = errors.New("token revoked")

// SessionState is what a service reads for one user to say whether that user's tokens still stand: the current
// token_version and the sign-ins that were signed out, each named by the auth_time its tokens carry.
type SessionState struct {
	Version   int
	SignedOut []int64
}

// SignedOutAt reports whether the sign-in at signIn (TokenPayload.SignIn; 0 for a token of no sign-in) was signed out.
func (s SessionState) SignedOutAt(signIn int64) bool {
	return signIn > 0 && slices.Contains(s.SignedOut, signIn)
}

// SessionStateQuery reads a SessionState in one statement, $1 the user's id; no row means the user is gone.
// auth-service's token-version route and its own routes answer from it, and k8s-service's open connections read it
// from the shared database (internal/sessioncheck). The signed-out sign-ins come from the primary key's index.
const SessionStateQuery = `SELECT token_version, ARRAY(SELECT auth_time FROM ended_sign_ins WHERE user_id = $1 ORDER BY auth_time) FROM auth_users WHERE id = $1`

type tokenVersionEntry struct {
	version   int
	signedOut []int64
	fetched   time.Time
}

func (e tokenVersionEntry) state() SessionState {
	return SessionState{Version: e.version, SignedOut: e.signedOut}
}

// checkTokenVersion compares claimed with the user's current version, asking
// auth-service at most once per cache TTL. Versions only grow, so a token
// claiming more than the cached version was issued after the cache entry
// (sign-in right after a role change): that refreshes the cache instead of
// waiting for it to expire. When auth-service cannot be reached, a version
// fetched within the stale TTL still counts; with nothing cached the token is
// refused rather than trusted.
//
// A token an API key was exchanged for (akid) is cached apart from the user's
// other tokens: auth-service answers "revoked" for it once the key is deleted
// or expired, and a sign-in token of the same user must not keep refreshing a
// shared entry that lets the key's token through.
//
// The answer also lists the user's signed-out sign-ins, so one lookup per
// user serves every sign-in of that user: signIn is the token's
// (TokenPayload.SignIn), 0 for a token of no sign-in.
func (v *JWTValidator) checkTokenVersion(tokenStr, userID, akid string, claimed int, signIn int64) error {
	now := time.Now()
	key := userID
	if akid != "" {
		key = userID + "|" + akid
	}
	v.tvMu.Lock()
	entry, cached := v.tv[key]
	v.tvMu.Unlock()
	if cached && now.Sub(entry.fetched) < v.cfg.TokenVersionCacheTTL && claimed <= entry.version {
		return compareSession(claimed, signIn, entry.state())
	}

	current, fetched, err := v.fetchTokenVersionShared(tokenStr, userID, now)
	switch {
	case err == nil:
		v.tvMu.Lock()
		v.tv[key] = tokenVersionEntry{version: current.Version, signedOut: current.SignedOut, fetched: fetched}
		v.tvMu.Unlock()
		return compareSession(claimed, signIn, current)
	case errors.Is(err, ErrTokenRevoked):
		v.tvMu.Lock()
		delete(v.tv, key)
		v.tvMu.Unlock()
		return err
	case cached && now.Sub(entry.fetched) < v.cfg.TokenVersionStaleTTL:
		// Outage: the signature proves auth-service issued the token at
		// version claimed, so anything not older than what we last saw
		// passes; an older one was revoked before the outage, and a sign-in
		// seen signed out stays so.
		if claimed < entry.version || entry.state().SignedOutAt(signIn) {
			return fmt.Errorf("invalid token: %w", ErrTokenRevoked)
		}
		return nil
	default:
		return fmt.Errorf("invalid token: token version unavailable: %w", err)
	}
}

type tokenVersionCall struct {
	done    chan struct{}
	started time.Time
	state   SessionState
	err     error
}

var errTokenVersionUnfinished = errors.New("token version lookup did not finish")

// fetchTokenVersionShared is one lookup for a token's requests at one moment, keyed by the token: auth-service answers for the token itself.
func (v *JWTValidator) fetchTokenVersionShared(tokenStr, userID string, now time.Time) (state SessionState, fetched time.Time, err error) {
	v.tvMu.Lock()
	if c, ok := v.tvCalls[tokenStr]; ok {
		v.tvMu.Unlock()
		<-c.done
		return c.state, c.started, c.err
	}
	c := &tokenVersionCall{done: make(chan struct{}), started: now, err: errTokenVersionUnfinished}
	v.tvCalls[tokenStr] = c
	v.tvMu.Unlock()
	defer func() {
		v.tvMu.Lock()
		delete(v.tvCalls, tokenStr)
		v.tvMu.Unlock()
		close(c.done)
	}()
	c.state, c.err = v.fetchTokenVersion(tokenStr, userID)
	return c.state, c.started, c.err
}

// compareSession says whether a token of version claimed and sign-in signIn stands against state.
func compareSession(claimed int, signIn int64, state SessionState) error {
	if claimed != state.Version {
		return fmt.Errorf("invalid token: %w", ErrTokenRevoked)
	}
	if state.SignedOutAt(signIn) {
		return fmt.Errorf("invalid token: signed out: %w", ErrTokenRevoked)
	}
	return nil
}

// fetchTokenVersion asks auth-service for the bearer's current version and
// signed-out sign-ins. The endpoint only answers for the token's own subject,
// so the token itself is the credential. 401/403/404 mean the token or user
// is gone (revoked); any other failure is a transport problem the caller may
// bridge from cache. An answer without "signed_out" lists none.
func (v *JWTValidator) fetchTokenVersion(tokenStr, userID string) (SessionState, error) {
	req, err := http.NewRequest(http.MethodGet, v.cfg.TokenVersionURL+"/"+userID, nil)
	if err != nil {
		return SessionState{}, err
	}
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return SessionState{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return SessionState{}, fmt.Errorf("%w (auth-service %d)", ErrTokenRevoked, resp.StatusCode)
	default:
		return SessionState{}, fmt.Errorf("auth-service token-version: status %d", resp.StatusCode)
	}
	var body struct {
		TV        int     `json:"tv"`
		SignedOut []int64 `json:"signed_out"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return SessionState{}, fmt.Errorf("auth-service token-version: %w", err)
	}
	return SessionState{Version: body.TV, SignedOut: body.SignedOut}, nil
}
