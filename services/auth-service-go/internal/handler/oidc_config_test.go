package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

// The login page decides from this response whether to offer "Create account";
// the flag must follow ALLOW_REGISTRATION so a closed deployment never shows a
// form that the server will refuse.
func TestOIDCConfig_ReportsRegistration(t *testing.T) {
	for _, allow := range []bool{false, true} {
		h := &AuthHandler{cfg: config.Config{AllowRegistration: allow, PasswordLogin: "on"}}
		rr := httptest.NewRecorder()
		h.OIDCConfig(rr, httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/config", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d", rr.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("body: %v", err)
		}
		if got, ok := body["registration"].(bool); !ok || got != allow {
			t.Errorf("registration = %v (present=%v), want %v", body["registration"], ok, allow)
		}
		if body["enabled"] != false || body["password_login"] != "on" {
			t.Errorf("existing fields changed: %v", body)
		}
	}
}
