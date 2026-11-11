package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A key's name is up to 64 characters as the screen's field counts them: 64 Korean letters (192 bytes) pass the name
// check and stop at the next one (expires_in_days 0), 65 are refused for the name.
func TestAnAPIKeyNameIsCountedInCharacters(t *testing.T) {
	h := &AuthHandler{cfg: config.Config{APIKeys: config.APIKeysConfig{Enabled: true, MaxDays: 90}}}
	for _, tc := range []struct {
		name, want string
	}{
		{strings.Repeat("키", 64), "expires_in_days"},
		{strings.Repeat("a", 64), "expires_in_days"},
		{strings.Repeat("키", 65), "name is required (up to 64 characters)"},
		{"  ", "name is required (up to 64 characters)"},
	} {
		body, _ := json.Marshal(map[string]any{"name": tc.name, "expires_in_days": 0})
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/api-keys", strings.NewReader(string(body)))
		r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "u1@example.com"}))
		w := httptest.NewRecorder()
		h.CreateAPIKey(w, r)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tc.want) {
			t.Errorf("%d letters: %d %s, want 400 %q", len([]rune(tc.name)), w.Code, w.Body.String(), tc.want)
		}
	}
}
