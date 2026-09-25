package security

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// TokenVersionLookup returns the user's current revocation counter. An error
// (unknown user) rejects the token.
type TokenVersionLookup func(ctx context.Context, userID string) (int, error)

// AuthMiddleware validates JWTs using the local JWTManager's public key directly.
// This avoids the self-referencing JWKS issue where auth-service tries to fetch
// its own JWKS endpoint before the server starts. When tokenVersion is set, the
// token's "tv" claim must equal the stored counter, so a bump revokes it at once.
// The token comes from the Authorization header (API clients) or, for the
// browser, from the HttpOnly session cookie named cookieName; cookie-authenticated
// state changes must carry the X-Requested-With header (CSRF).
func AuthMiddleware(jwtMgr *JWTManager, tokenVersion TokenVersionLookup, cookieName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr := ""
			fromCookie := false
			if authHeader := r.Header.Get("Authorization"); authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
					http.Error(w, `{"detail":"Invalid Authorization header"}`, http.StatusUnauthorized)
					return
				}
				tokenStr = strings.TrimSpace(parts[1])
			} else if cookieName != "" {
				if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
					tokenStr = c.Value
					fromCookie = true
				}
			}
			if tokenStr == "" {
				http.Error(w, `{"detail":"Missing Authorization header"}`, http.StatusUnauthorized)
				return
			}
			if !auth.CSRFSafe(r, fromCookie) {
				http.Error(w, `{"detail":"Missing X-Requested-With header"}`, http.StatusForbidden)
				return
			}

			claims, err := jwtMgr.ValidateToken(tokenStr)
			if err != nil {
				http.Error(w, `{"detail":"Invalid token"}`, http.StatusUnauthorized)
				return
			}

			userID := strings.TrimSpace(fmt.Sprintf("%v", claims["sub"]))
			if userID == "" || userID == "<nil>" {
				http.Error(w, `{"detail":"Invalid token"}`, http.StatusUnauthorized)
				return
			}

			if tokenVersion != nil {
				claimed, _ := claims["tv"].(float64) // JSON numbers decode as float64; missing claim = 0
				current, err := tokenVersion(r.Context(), userID)
				if err != nil || int(claimed) != current {
					http.Error(w, `{"detail":"Token revoked"}`, http.StatusUnauthorized)
					return
				}
			}

			email := strings.TrimSpace(fmt.Sprintf("%v", claims["email"]))
			if email == "<nil>" {
				email = ""
			}

			role := strings.TrimSpace(strings.ToLower(fmt.Sprintf("%v", claims["role"])))
			if role == "" || role == "<nil>" {
				role = "read"
			}

			// Per-cluster permission matrix. A legacy flat-array claim parses
			// to nil → reject so the stale token forces a re-login.
			perms := auth.ParsePermissions(claims["permissions"])
			if perms == nil {
				http.Error(w, `{"detail":"Invalid token"}`, http.StatusUnauthorized)
				return
			}

			payload := auth.TokenPayload{UserID: userID, Email: email, Role: role, Perms: perms, Roles: auth.ParseRoles(claims["roles"])}
			ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
