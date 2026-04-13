package security

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// AuthMiddleware validates JWTs using the local JWTManager's public key directly.
// This avoids the self-referencing JWKS issue where auth-service tries to fetch
// its own JWKS endpoint before the server starts.
func AuthMiddleware(jwtMgr *JWTManager) func(http.Handler) http.Handler {
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

			role := strings.TrimSpace(strings.ToLower(fmt.Sprintf("%v", claims["role"])))
			if role == "" || role == "<nil>" {
				role = "read"
			}

			var permissions []string
			if permsRaw, ok := claims["permissions"]; ok {
				if permsList, ok := permsRaw.([]interface{}); ok {
					for _, p := range permsList {
						if s, ok := p.(string); ok {
							permissions = append(permissions, s)
						}
					}
				}
			}

			payload := auth.TokenPayload{UserID: userID, Role: role, Permissions: permissions}
			ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
