// Package github is the controller's connection to GitHub as a GitHub App:
// it signs the app's JWT, keeps installation access tokens, and asks the
// GraphQL API for what polling and a build need — the heads of many
// repositories in one query, and a commit with its pipeline file in
// another. Everything a webhook says is read again here before a build.
package github

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// APIVersion is the REST API version sent with every REST call, the one
// GitHub's installation token documentation uses (checked 2026-11-01).
const APIVersion = "2026-03-10"

// DefaultBaseURL is github.com's API. GitHub Enterprise Server's is
// https://<host>/api/v3.
const DefaultBaseURL = "https://api.github.com"

// UserAgent is sent with every call; GitHub refuses REST calls without one.
const UserAgent = "kubeast-ci-controller"

// RefreshBefore is how long before its expiry an installation token is
// replaced. A token is valid for an hour, and a build pod clones a few
// minutes after the controller hands it the token (queue, image pull), so
// the margin is larger than client libraries' usual minute.
const RefreshBefore = 10 * time.Minute

// App is a GitHub App's identity. It is safe for concurrent use.
type App struct {
	// ID is the app ID or client ID, the JWT's issuer.
	ID  string
	Key *rsa.PrivateKey
	// BaseURL is the REST API root. Empty: DefaultBaseURL.
	BaseURL string
	// Permissions, when set, narrow every installation token to these
	// (for example contents: read, checks: write, metadata: read).
	Permissions map[string]string
	HTTP        *http.Client
	Now         func() time.Time

	mu     sync.Mutex
	tokens map[int64]Token
}

// Token is an installation access token. String never shows its value.
type Token struct {
	Value     string
	ExpiresAt time.Time
}

func (t Token) String() string {
	return fmt.Sprintf("installation token (expires %s)", t.ExpiresAt.UTC().Format(time.RFC3339))
}

// ParsePrivateKey reads the app's private key as GitHub hands it out
// (PEM, PKCS #1) or as PKCS #8.
func ParsePrivateKey(data []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("github: private key: no PEM block")
	}
	switch block.Type {
	case "RSA PRIVATE KEY":
		return x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("github: private key: not an RSA key")
		}
		return rk, nil
	default:
		return nil, fmt.Errorf("github: private key: PEM block %q", block.Type)
	}
}

func (a *App) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *App) baseURL() string {
	if a.BaseURL == "" {
		return DefaultBaseURL
	}
	return strings.TrimRight(a.BaseURL, "/")
}

func (a *App) client() *http.Client {
	if a.HTTP != nil {
		return a.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// JWT signs the app's JSON Web Token: RS256, issued 60 seconds in the past
// against clock drift and expiring 5 minutes from now (GitHub allows at
// most 10), as "Generating a JSON Web Token (JWT) for a GitHub App" says.
func (a *App) JWT() (string, error) {
	if a.ID == "" || a.Key == nil {
		return "", errors.New("github: app ID and private key are required")
	}
	now := a.now().Unix()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, err := json.Marshal(map[string]any{"iat": now - 60, "exp": now + 5*60, "iss": a.ID})
	if err != nil {
		return "", err
	}
	signing := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, a.Key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("github: signing the app JWT: %w", err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// InstallationToken returns a token for the installation, from the cache
// while more than RefreshBefore of it is left.
func (a *App) InstallationToken(ctx context.Context, installation int64) (Token, error) {
	if installation <= 0 {
		return Token{}, errors.New("github: no installation ID")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if t, ok := a.tokens[installation]; ok && a.now().Before(t.ExpiresAt.Add(-RefreshBefore)) {
		return t, nil
	}
	t, err := a.fetchToken(ctx, installation)
	if err != nil {
		return Token{}, err
	}
	if a.tokens == nil {
		a.tokens = map[int64]Token{}
	}
	a.tokens[installation] = t
	return t, nil
}

// Forget drops the installation's cached token, after GitHub refused it.
func (a *App) Forget(installation int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.tokens, installation)
}

func (a *App) fetchToken(ctx context.Context, installation int64) (Token, error) {
	jwt, err := a.JWT()
	if err != nil {
		return Token{}, err
	}
	var body io.Reader
	if len(a.Permissions) > 0 {
		b, err := json.Marshal(map[string]any{"permissions": a.Permissions})
		if err != nil {
			return Token{}, err
		}
		body = bytes.NewReader(b)
	}
	url := a.baseURL() + "/app/installations/" + strconv.FormatInt(installation, 10) + "/access_tokens"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("X-GitHub-Api-Version", APIVersion)
	req.Header.Set("User-Agent", UserAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("github: installation %d token: %w", installation, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Token{}, fmt.Errorf("github: installation %d token: %w", installation, err)
	}
	if resp.StatusCode != http.StatusCreated {
		return Token{}, apiError(resp, data, fmt.Sprintf("installation %d token", installation))
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(data, &out); err != nil || out.Token == "" || out.ExpiresAt.IsZero() {
		return Token{}, fmt.Errorf("github: installation %d token: an answer without a token or expiry", installation)
	}
	return Token{Value: out.Token, ExpiresAt: out.ExpiresAt}, nil
}

// APIError is a refusal from GitHub. Message is GitHub's own message field,
// never the request or anything secret.
type APIError struct {
	Op         string
	Status     int
	Message    string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("github: %s: %d", e.Op, e.Status)
	if e.Message != "" {
		s += " " + e.Message
	}
	if e.RetryAfter > 0 {
		s += fmt.Sprintf(" (retry after %s)", e.RetryAfter)
	}
	return s
}

// RateLimited reports whether GitHub asked to wait (primary or secondary
// rate limit).
func (e *APIError) RateLimited() bool {
	return e.Status == http.StatusTooManyRequests || (e.Status == http.StatusForbidden && e.RetryAfter > 0)
}

func apiError(resp *http.Response, body []byte, op string) *APIError {
	e := &APIError{Op: op, Status: resp.StatusCode}
	var msg struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &msg) == nil && len(msg.Message) < 300 {
		e.Message = msg.Message
	}
	if s := resp.Header.Get("Retry-After"); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			e.RetryAfter = time.Duration(n) * time.Second
		}
	} else if resp.Header.Get("X-Ratelimit-Remaining") == "0" {
		if n, err := strconv.ParseInt(resp.Header.Get("X-Ratelimit-Reset"), 10, 64); err == nil {
			if d := time.Until(time.Unix(n, 0)); d > 0 {
				e.RetryAfter = d
			}
		}
	}
	return e
}
