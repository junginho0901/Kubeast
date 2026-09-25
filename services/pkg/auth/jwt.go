package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrUnknownKid is returned when the token's kid is not in the JWKS.
var ErrUnknownKid = errors.New("signing key not found")

// jwksRefetchMinInterval bounds how often an unknown kid or a bad signature can
// trigger a JWKS fetch, so a flood of garbage tokens cannot hammer auth-service.
const jwksRefetchMinInterval = 10 * time.Second

// TokenPayload contains the validated JWT claims.
type TokenPayload struct {
	UserID string
	Email  string            // populated from "email" claim (for audit logs)
	Role   string            // 하위호환 유지
	Perms  PermissionMatrix  // per-cluster permission matrix (cluster id → perms, "*" = all)
	Roles  map[string]string // "roles" claim: cluster id → role name, for impersonation groups
}

// ParseRoles converts the raw "roles" claim ({cluster: roleName}) into a map;
// a missing or malformed claim yields nil (no cluster roles).
func ParseRoles(raw any) map[string]string {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(m))
	for cid, v := range m {
		if s, ok := v.(string); ok && s != "" {
			out[cid] = s
		}
	}
	return out
}

// HasPermission checks a GLOBAL permission (cluster-agnostic) — i.e. the "*"
// entry only. Use it for admin.* checks that are not scoped to a cluster. For
// cluster-scoped resource access use HasPermissionForCluster.
func (p TokenPayload) HasPermission(perm string) bool {
	return p.Perms.HasForCluster(perm, "*")
}

// HasPermissionForCluster checks whether perm is granted in clusterID (honoring
// the all-cluster "*" entry).
func (p TokenPayload) HasPermissionForCluster(perm, clusterID string) bool {
	return p.Perms.HasForCluster(perm, clusterID)
}

type contextKey string

const tokenPayloadKey contextKey = "tokenPayload"

// FromContext extracts TokenPayload from request context.
func FromContext(ctx context.Context) (TokenPayload, bool) {
	p, ok := ctx.Value(tokenPayloadKey).(TokenPayload)
	return p, ok
}

// TokenPayloadContextKey returns the context key used for storing TokenPayload.
// This allows other packages to set the value directly (e.g., auth-service validating its own tokens).
func TokenPayloadContextKey() contextKey {
	return tokenPayloadKey
}

// JWKSConfig holds configuration for JWKS-based JWT validation.
type JWKSConfig struct {
	JWKSURL  string
	Issuer   string
	Audience string
}

// JWTValidator validates JWTs using JWKS public keys.
type JWTValidator struct {
	cfg        JWKSConfig
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	lastFetch  time.Time
	fetchMu    sync.Mutex // serializes refetches
	httpClient *http.Client
}

// NewJWTValidator creates a new validator.
func NewJWTValidator(cfg JWKSConfig) *JWTValidator {
	return &JWTValidator{
		cfg:        cfg,
		keys:       make(map[string]*rsa.PublicKey),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// jwksResponse represents the JWKS endpoint response.
type jwksResponse struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Alg string `json:"alg"`
}

func (v *JWTValidator) fetchKeys() error {
	resp, err := v.httpClient.Get(v.cfg.JWKSURL)
	if err != nil {
		return fmt.Errorf("failed to fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("JWKS endpoint returned status %d", resp.StatusCode)
	}

	var jwks jwksResponse
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return fmt.Errorf("failed to decode JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey)
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pubKey, err := parseRSAPublicKey(k.N, k.E)
		if err != nil {
			continue
		}
		keys[k.Kid] = pubKey
	}

	v.mu.Lock()
	v.keys = keys
	v.lastFetch = time.Now()
	v.mu.Unlock()

	return nil
}

func parseRSAPublicKey(nStr, eStr string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nStr)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eStr)
	if err != nil {
		return nil, err
	}

	n := new(big.Int).SetBytes(nBytes)
	e := new(big.Int).SetBytes(eBytes)

	return &rsa.PublicKey{
		N: n,
		E: int(e.Int64()),
	}, nil
}

// refetchKeys fetches the JWKS unless one was fetched less than
// jwksRefetchMinInterval ago. Returns (fetched, error).
func (v *JWTValidator) refetchKeys() (bool, error) {
	v.fetchMu.Lock()
	defer v.fetchMu.Unlock()
	v.mu.RLock()
	last := v.lastFetch
	v.mu.RUnlock()
	if time.Since(last) < jwksRefetchMinInterval {
		return false, nil
	}
	return true, v.fetchKeys()
}

func (v *JWTValidator) lookupKey(kid string) (*rsa.PublicKey, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	key, ok := v.keys[kid]
	return key, ok
}

// getKey returns the public key for kid, refetching the JWKS (rate-limited)
// when the kid is not cached — a rotated auth-service key has a new kid.
func (v *JWTValidator) getKey(kid string) (*rsa.PublicKey, error) {
	if key, ok := v.lookupKey(kid); ok {
		return key, nil
	}
	if _, err := v.refetchKeys(); err != nil {
		return nil, err
	}
	if key, ok := v.lookupKey(kid); ok {
		return key, nil
	}
	return nil, fmt.Errorf("%w for kid: %s", ErrUnknownKid, kid)
}

func (v *JWTValidator) parse(tokenStr string) (*jwt.Token, error) {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.cfg.Issuer),
		jwt.WithAudience(v.cfg.Audience),
	)
	return parser.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok {
			return nil, fmt.Errorf("missing kid in token header")
		}
		return v.getKey(kid)
	})
}

// Validate validates a JWT token and returns the payload.
//
// A signature failure on a cached kid triggers one rate-limited JWKS refetch
// and a second parse: auth-service may have been restarted with a new key
// while this process still caches the old one.
func (v *JWTValidator) Validate(tokenStr string) (TokenPayload, error) {
	token, err := v.parse(tokenStr)
	if err != nil && errors.Is(err, jwt.ErrTokenSignatureInvalid) {
		if fetched, ferr := v.refetchKeys(); ferr == nil && fetched {
			token, err = v.parse(tokenStr)
		}
	}
	if err != nil {
		return TokenPayload{}, fmt.Errorf("invalid token: %w", err)
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return TokenPayload{}, fmt.Errorf("invalid token claims")
	}

	userID := strings.TrimSpace(fmt.Sprintf("%v", claims["sub"]))
	if userID == "" || userID == "<nil>" {
		return TokenPayload{}, fmt.Errorf("missing sub claim")
	}

	email := strings.TrimSpace(fmt.Sprintf("%v", claims["email"]))
	if email == "<nil>" {
		email = ""
	}

	role := strings.TrimSpace(strings.ToLower(fmt.Sprintf("%v", claims["role"])))
	if role == "" || role == "<nil>" {
		role = "read"
	}

	// Per-cluster permission matrix. The legacy flat-array claim parses to nil,
	// which we reject so a stale token forces a one-time re-login after the
	// format switch (00-COMMON §2-3).
	perms := ParsePermissions(claims["permissions"])
	if perms == nil {
		return TokenPayload{}, fmt.Errorf("invalid token: permissions claim must be a per-cluster map (re-login required)")
	}

	return TokenPayload{UserID: userID, Email: email, Role: role, Perms: perms, Roles: ParseRoles(claims["roles"])}, nil
}

// CSRFHeader must accompany cookie-authenticated requests that can change
// state (anything but GET/HEAD/OPTIONS). A cross-site page cannot add a custom
// header without a CORS preflight, so its forged request is refused even
// though the browser attaches the session cookie (OWASP CSRF cheat sheet,
// "custom request headers"). Bearer-authenticated calls (API clients) are not
// subject to it.
const (
	CSRFHeader      = "X-Requested-With"
	CSRFHeaderValue = "XMLHttpRequest"
)

// CSRFSafe reports whether a request authenticated by cookie may proceed.
func CSRFSafe(r *http.Request, fromCookie bool) bool {
	if !fromCookie {
		return true
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return r.Header.Get(CSRFHeader) == CSRFHeaderValue
}

// Middleware returns an HTTP middleware that validates JWT tokens.
// It checks the Authorization header first, then falls back to a cookie
// (needed for browser WebSocket connections which can't set custom headers).
func (v *JWTValidator) Middleware(next http.Handler) http.Handler {
	return v.MiddlewareWithCookie("kubeast.token", next)
}

// MiddlewareWithCookie returns middleware that checks Authorization header first,
// then falls back to the named cookie for token extraction.
func (v *JWTValidator) MiddlewareWithCookie(cookieName string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var tokenStr string

		// 1. Try Authorization header
		auth := r.Header.Get("Authorization")
		if auth != "" {
			parts := strings.SplitN(auth, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
				tokenStr = strings.TrimSpace(parts[1])
			}
		}

		// 2. Fallback to cookie — the browser's session (HttpOnly cookie set at
		//    login; also what WebSocket upgrades carry). A query-string token is
		//    not accepted: it ends up in access logs, history and Referer.
		fromCookie := false
		if tokenStr == "" && cookieName != "" {
			if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
				tokenStr = c.Value
				fromCookie = true
			}
		}

		if tokenStr == "" {
			http.Error(w, `{"detail":"Missing Authorization header"}`, http.StatusUnauthorized)
			return
		}
		if !CSRFSafe(r, fromCookie) {
			http.Error(w, `{"detail":"Missing X-Requested-With header"}`, http.StatusForbidden)
			return
		}

		payload, err := v.Validate(tokenStr)
		if err != nil {
			http.Error(w, `{"detail":"Invalid token"}`, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), tokenPayloadKey, payload)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
