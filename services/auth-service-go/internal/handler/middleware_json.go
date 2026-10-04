package handler

import (
	"mime"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// RequireJSON refuses a body that is not declared application/json. The
// public login and registration endpoints are reachable without a session, so
// a cross-site <form enctype="text/plain"> could otherwise post a JSON-shaped
// body and sign the victim into an attacker's account (login CSRF). A browser
// cannot send application/json cross-site without a CORS preflight (OWASP
// CSRF Prevention: a request is "simple" only with form/text content types).
func RequireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mt != "application/json" {
			response.Error(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
			return
		}
		next.ServeHTTP(w, r)
	})
}
