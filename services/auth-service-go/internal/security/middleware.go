package security

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// TokenVersionLookup returns the user's current revocation counter and
// signed-out sign-ins (auth.SessionStateQuery). An error (unknown user, or for
// a token an API key was exchanged for, a key revoked or expired since)
// rejects the token.
type TokenVersionLookup func(ctx context.Context, userID, apiKeyID string) (auth.SessionState, error)

// RefreshPath is the one route a token of a signed-out sign-in reaches: the
// middleware marks it (SignedOut) and Refresh refuses it as it refuses a
// session past its absolute lifetime, with an audit row.
const RefreshPath = "/api/v1/auth/refresh"

type signedOutKey struct{}

// SignedOut reports whether the middleware found the request's sign-in signed out (RefreshPath only).
func SignedOut(ctx context.Context) bool {
	v, _ := ctx.Value(signedOutKey{}).(bool)
	return v
}

// SignInTime is the sign-in a token's claims belong to, as auth.TokenPayload.SignIn reads it: "auth_time", or "iat"
// for a token issued before that claim; 0 for a token an API key was exchanged for or a system token.
func SignInTime(claims map[string]any) int64 {
	if akid, _ := claims["akid"].(string); akid != "" {
		return 0
	}
	if sys, _ := claims["sys"].(string); sys != "" {
		return 0
	}
	return authTimeOf(claims)
}

func authTimeOf(claims map[string]any) int64 {
	if f, ok := claims["auth_time"].(float64); ok && f > 0 {
		return int64(f)
	}
	if f, ok := claims["iat"].(float64); ok && f > 0 {
		return int64(f)
	}
	return 0
}

// AuthMiddleware validates JWTs using the local JWTManager's public key directly.
// This avoids the self-referencing JWKS issue where auth-service tries to fetch
// its own JWKS endpoint before the server starts. When tokenVersion is set, the
// token's "tv" claim must equal the stored counter, so a bump revokes it at once,
// and a token of a signed-out sign-in is refused (on RefreshPath it is marked
// for the handler instead) — the same statement answers both.
// The token comes from the Authorization header (API clients) or, for the
// browser, from the HttpOnly session cookie named cookieName; cookie-authenticated
// state changes must carry the X-Requested-With header (CSRF). A system token
// ("sys") has no account and is refused.
func AuthMiddleware(jwtMgr *JWTManager, tokenVersion TokenVersionLookup, cookieName string) func(http.Handler) http.Handler {
	return tokenMiddleware(jwtMgr, tokenVersion, cookieName, false)
}

// InvestigatorReadMiddleware is AuthMiddleware for a read route an alert
// investigation calls: while investigations are enabled it also takes the
// investigator's token, as the token-version route does. That token has no account
// row to check; its signature, expiry and permissions hold as for any other.
func InvestigatorReadMiddleware(jwtMgr *JWTManager, tokenVersion TokenVersionLookup, cookieName string, enabled bool) func(http.Handler) http.Handler {
	return tokenMiddleware(jwtMgr, tokenVersion, cookieName, enabled)
}

func tokenMiddleware(jwtMgr *JWTManager, tokenVersion TokenVersionLookup, cookieName string, takesInvestigator bool) func(http.Handler) http.Handler {
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

			sys, _ := claims["sys"].(string)
			if sys != "" && (!takesInvestigator || fromCookie || sys != auth.SystemInvestigator || userID != InvestigatorSubject) {
				http.Error(w, `{"detail":"This route does not take a system token"}`, http.StatusForbidden)
				return
			}

			ctx := r.Context()
			if tokenVersion != nil && sys == "" {
				claimed, _ := claims["tv"].(float64) // JSON numbers decode as float64; missing claim = 0
				akid, _ := claims["akid"].(string)
				current, err := tokenVersion(r.Context(), userID, akid)
				if err != nil || int(claimed) != current.Version {
					http.Error(w, `{"detail":"Token revoked"}`, http.StatusUnauthorized)
					return
				}
				if current.SignedOutAt(SignInTime(claims)) {
					if r.URL.Path != RefreshPath {
						http.Error(w, `{"detail":"Session expired; sign in again"}`, http.StatusUnauthorized)
						return
					}
					ctx = context.WithValue(ctx, signedOutKey{}, true)
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

			// auth_time: when the user last signed in (refresh keeps it); older
			// tokens without it count from iat. Refresh enforces the absolute
			// session lifetime from this value.
			authTime := authTimeOf(claims)

			// A pending account may only see its own state, keep its session and
			// sign out (same rule as pkg/auth's middleware in the other services).
			if role == "pending" {
				if _, allowed := auth.PendingAllowedPaths[r.URL.Path]; !allowed {
					http.Error(w, `{"detail":"Account pending approval"}`, http.StatusForbidden)
					return
				}
			}

			akid, _ := claims["akid"].(string)
			payload := auth.TokenPayload{UserID: userID, Email: email, Role: role, Perms: perms, Roles: auth.ParseRoles(claims["roles"]), Namespaces: auth.ParseNamespaces(claims["ns"]), AuthTime: authTime, APIKeyID: akid, System: sys}
			ctx = context.WithValue(ctx, auth.TokenPayloadContextKey(), payload)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
