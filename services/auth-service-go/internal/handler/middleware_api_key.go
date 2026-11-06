package handler

import (
	"errors"
	"net/http"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

const apiKeyTokenRefused = "An API key token cannot do this; it is for a signed-in person"

// RefuseAPIKeyToken keeps a route to a signed-in person: a token an API key was
// exchanged for carries the key's cut-down scope, which a new key or a new
// password would outlive, and a row it wrote would read as the person's. The
// refused attempt leaves a failure row of action.
func RefuseAPIKeyToken(store audit.Store, action string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			payload, ok := auth.FromContext(r.Context())
			if !ok || payload.APIKeyID == "" {
				next.ServeHTTP(w, r)
				return
			}
			writeAudit(store, r, payload, auditEvent{
				action: action, targetType: "user", targetID: payload.UserID, targetEmail: payload.Email,
				after: map[string]string{"akid": payload.APIKeyID, "method": r.Method, "path": r.URL.Path},
				err:   errors.New("refused for an API key token"),
			})
			response.Error(w, http.StatusForbidden, apiKeyTokenRefused)
		})
	}
}
