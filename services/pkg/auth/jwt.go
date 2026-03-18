package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// TokenPayload contains the validated JWT claims.
type TokenPayload struct {
	UserID string
	Role   string
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

func (v *JWTValidator) getKey(kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	key, ok := v.keys[kid]
	lastFetch := v.lastFetch
	v.mu.RUnlock()

	if ok {
		return key, nil
	}

	// Refetch if keys are stale (>5 min) or key not found
	if time.Since(lastFetch) > 5*time.Minute || !ok {
		if err := v.fetchKeys(); err != nil {
			return nil, err
		}
		v.mu.RLock()
		key, ok = v.keys[kid]
		v.mu.RUnlock()
		if !ok {
			return nil, fmt.Errorf("signing key not found for kid: %s", kid)
		}
		return key, nil
	}

	return nil, fmt.Errorf("signing key not found for kid: %s", kid)
}

// Validate validates a JWT token and returns the payload.
func (v *JWTValidator) Validate(tokenStr string) (TokenPayload, error) {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.cfg.Issuer),
		jwt.WithAudience(v.cfg.Audience),
	)

	token, err := parser.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		kid, ok := token.Header["kid"].(string)
		if !ok {
			return nil, fmt.Errorf("missing kid in token header")
		}
		return v.getKey(kid)
	})
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

	role := strings.TrimSpace(strings.ToLower(fmt.Sprintf("%v", claims["role"])))
	if role == "" || role == "<nil>" {
		role = "read"
	}

	return TokenPayload{UserID: userID, Role: role}, nil
}

// Middleware returns an HTTP middleware that validates JWT tokens.
// It checks the Authorization header first, then falls back to a cookie
// (needed for browser WebSocket connections which can't set custom headers).
func (v *JWTValidator) Middleware(next http.Handler) http.Handler {
	return v.MiddlewareWithCookie("kube-assistant.token", next)
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

		// 2. Fallback to cookie (for WebSocket connections)
		if tokenStr == "" && cookieName != "" {
			if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
				tokenStr = c.Value
			}
		}

		// 3. Fallback to query parameter (for WebSocket connections that can't set headers)
		if tokenStr == "" {
			if q := r.URL.Query().Get("token"); q != "" {
				tokenStr = q
			}
		}

		if tokenStr == "" {
			http.Error(w, `{"detail":"Missing Authorization header"}`, http.StatusUnauthorized)
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
