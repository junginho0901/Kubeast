// Package internalauth authenticates service-to-service calls on the
// /internal routes with a shared bearer-style token (header X-Internal-Token).
//
// The gateway never proxies /internal, so these routes are reachable only on
// the cluster network; the token makes the *caller* a known service as well,
// so a user's session alone (or any pod that can open a connection) cannot
// pull a cluster kubeconfig. The end user's own credential still travels in
// Authorization for authorization and the audit actor — the two are checked
// separately (OWASP microservices: authenticate the calling service, propagate
// the user context as its own validated claim).
//
// The token is static (a Secret value, like a Kubernetes static token file):
// changing it means rolling the services that hold it. An unset token refuses
// every internal call with 503 rather than letting them through.
package internalauth

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// Header carries the token.
const Header = "X-Internal-Token"

// Env is the variable every service reads the token from.
const Env = "INTERNAL_API_TOKEN"

// Middleware refuses requests whose token does not match. token == "" refuses
// all of them (503) so a misconfigured deployment fails closed and visibly.
func Middleware(token string) func(http.Handler) http.Handler {
	token = strings.TrimSpace(token)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token == "" {
				http.Error(w, `{"detail":"internal API token not configured"}`, http.StatusServiceUnavailable)
				return
			}
			got := strings.TrimSpace(r.Header.Get(Header))
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				http.Error(w, `{"detail":"internal API token required"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Set puts the token on an outgoing request (no-op when empty, so the callee
// answers 401 and the log says why).
func Set(req *http.Request, token string) {
	if token = strings.TrimSpace(token); token != "" {
		req.Header.Set(Header, token)
	}
}
