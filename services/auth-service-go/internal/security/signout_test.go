package security

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A token of a signed-out sign-in is refused at once on every route but refresh, which it reaches marked; the user's
// other sign-ins and a key's token of the same second go on.
func TestAuthMiddleware_ASignedOutSignInReachesOnlyRefreshAndIsMarkedThere(t *testing.T) {
	m := newTestManager(t)
	perms := auth.PermissionMatrix{"*": {"*"}}
	signedIn := time.Now().Add(-time.Hour).Truncate(time.Second)
	keyTok, err := m.CreateAPIKeyToken("u1", "u1@example.com", "admin", perms, nil, nil, 1, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	keyClaims, err := m.ClaimsIgnoringExpiry(keyTok)
	if err != nil {
		t.Fatal(err)
	}
	keySecond := int64(keyClaims["auth_time"].(float64))
	lookup := func(context.Context, string, string) (auth.SessionState, error) {
		return auth.SessionState{Version: 1, SignedOut: []int64{signedIn.Unix(), keySecond}}, nil
	}
	mw := AuthMiddleware(m, lookup, "kubeast.token")
	ended, _ := m.CreateTokenAt("u1", "u1@example.com", "admin", perms, nil, nil, 1, signedIn)
	other, _ := m.CreateTokenAt("u1", "u1@example.com", "admin", perms, nil, nil, 1, signedIn.Add(time.Second))

	call := func(token, path string) (int, bool) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		marked := false
		mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			marked = SignedOut(r.Context())
			w.WriteHeader(http.StatusOK)
		})).ServeHTTP(rec, req)
		return rec.Code, marked
	}
	if code, _ := call(ended, "/api/v1/auth/me"); code != http.StatusUnauthorized {
		t.Errorf("signed out on /me: %d, want 401", code)
	}
	if code, _ := call(ended, "/api/v1/clusters"); code != http.StatusUnauthorized {
		t.Errorf("signed out on /clusters: %d, want 401", code)
	}
	if code, marked := call(ended, RefreshPath); code != http.StatusOK || !marked {
		t.Errorf("signed out on refresh: %d marked %v, want the handler, marked", code, marked)
	}
	if code, marked := call(other, RefreshPath); code != http.StatusOK || marked {
		t.Errorf("another sign-in on refresh: %d marked %v", code, marked)
	}
	if code, _ := call(other, "/api/v1/auth/me"); code != http.StatusOK {
		t.Errorf("another sign-in on /me: %d", code)
	}
	if code, marked := call(keyTok, "/api/v1/auth/me"); code != http.StatusOK || marked {
		t.Errorf("a key's token of the same second: %d marked %v", code, marked)
	}
}

func TestSignInTimeNamesTheSignInOfASessionTokenOnly(t *testing.T) {
	for _, c := range []struct {
		name   string
		claims map[string]any
		want   int64
	}{
		{"auth_time", map[string]any{"auth_time": float64(100), "iat": float64(200)}, 100},
		{"before auth_time", map[string]any{"iat": float64(200)}, 200},
		{"a key's token", map[string]any{"auth_time": float64(100), "akid": "k1"}, 0},
		{"a system token", map[string]any{"auth_time": float64(100), "sys": auth.SystemInvestigator}, 0},
		{"no time", map[string]any{}, 0},
	} {
		if got := SignInTime(c.claims); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}
