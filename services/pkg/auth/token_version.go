package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Token revocation. auth-service keeps a token_version per user and bumps it
// when a role or cluster grant changes, a password is reset or the user
// signs out everywhere; tokens carry the version they were issued with as
// "tv". auth-service checks it on its own routes; every other service reads
// the current version from auth-service here so a revoked token stops
// working within TokenVersionCacheTTL instead of at expiry.

// ErrTokenRevoked is returned when the token's "tv" is behind the user's
// current token_version (or the user no longer exists).
var ErrTokenRevoked = errors.New("token revoked")

type tokenVersionEntry struct {
	version int
	fetched time.Time
}

// checkTokenVersion compares claimed with the user's current version, asking
// auth-service at most once per cache TTL. Versions only grow, so a token
// claiming more than the cached version was issued after the cache entry
// (sign-in right after a role change): that refreshes the cache instead of
// waiting for it to expire. When auth-service cannot be reached, a version
// fetched within the stale TTL still counts; with nothing cached the token is
// refused rather than trusted.
func (v *JWTValidator) checkTokenVersion(tokenStr, userID string, claimed int) error {
	now := time.Now()
	v.tvMu.Lock()
	entry, cached := v.tv[userID]
	v.tvMu.Unlock()
	if cached && now.Sub(entry.fetched) < v.cfg.TokenVersionCacheTTL && claimed <= entry.version {
		return compareTokenVersion(claimed, entry.version)
	}

	current, err := v.fetchTokenVersion(tokenStr, userID)
	switch {
	case err == nil:
		v.tvMu.Lock()
		v.tv[userID] = tokenVersionEntry{version: current, fetched: now}
		v.tvMu.Unlock()
		return compareTokenVersion(claimed, current)
	case errors.Is(err, ErrTokenRevoked):
		v.tvMu.Lock()
		delete(v.tv, userID)
		v.tvMu.Unlock()
		return err
	case cached && now.Sub(entry.fetched) < v.cfg.TokenVersionStaleTTL:
		// Outage: the signature proves auth-service issued the token at
		// version claimed, so anything not older than what we last saw
		// passes; an older one was revoked before the outage.
		if claimed < entry.version {
			return fmt.Errorf("invalid token: %w", ErrTokenRevoked)
		}
		return nil
	default:
		return fmt.Errorf("invalid token: token version unavailable: %w", err)
	}
}

func compareTokenVersion(claimed, current int) error {
	if claimed != current {
		return fmt.Errorf("invalid token: %w", ErrTokenRevoked)
	}
	return nil
}

// fetchTokenVersion asks auth-service for the bearer's current version. The
// endpoint only answers for the token's own subject, so the token itself is
// the credential. 401/403/404 mean the token or user is gone (revoked); any
// other failure is a transport problem the caller may bridge from cache.
func (v *JWTValidator) fetchTokenVersion(tokenStr, userID string) (int, error) {
	req, err := http.NewRequest(http.MethodGet, v.cfg.TokenVersionURL+"/"+userID, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return 0, fmt.Errorf("%w (auth-service %d)", ErrTokenRevoked, resp.StatusCode)
	default:
		return 0, fmt.Errorf("auth-service token-version: status %d", resp.StatusCode)
	}
	var body struct {
		TV int `json:"tv"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, fmt.Errorf("auth-service token-version: %w", err)
	}
	return body.TV, nil
}
