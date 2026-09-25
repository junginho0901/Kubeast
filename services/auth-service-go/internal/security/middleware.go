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
func AuthMiddleware(jwtMgr *JWTManager, tokenVersion TokenVersionLookup) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"detail":"Missing Authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, `{"detail":"Invalid Authorization header"}`, http.StatusUnauthorized)
				return
			}

			tokenStr := strings.TrimSpace(parts[1])
			if tokenStr == "" {
				http.Error(w, `{"detail":"Invalid Authorization header"}`, http.StatusUnauthorized)
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
