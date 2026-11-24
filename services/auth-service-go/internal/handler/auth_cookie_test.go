package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
)

// The session cookie's Secure flag follows configuration, whatever
// X-Forwarded-Proto says: the chart's nginx rewrites that header to the
// scheme it was reached over, which is plain http behind a TLS-terminating
// proxy.
func TestSetAuthCookie_SecureFromConfig(t *testing.T) {
	for _, tc := range []struct {
		name   string
		secure bool
		proto  string
	}{
		{"secure config, http header", true, "http"},
		{"insecure config, https header", false, "https"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &AuthHandler{cfg: config.Config{AuthCookieName: "kubeast.token", JWTExpiresMinutes: 60, CookieSecure: tc.secure}}
			rr := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
			req.Header.Set("X-Forwarded-Proto", tc.proto)
			h.setAuthCookie(rr, req, "tok")
			cookies := rr.Result().Cookies()
			if len(cookies) != 1 || cookies[0].Name != "kubeast.token" {
				t.Fatalf("cookies = %v", cookies)
			}
			if cookies[0].Secure != tc.secure {
				t.Fatalf("Secure = %v, want %v (header %s must not decide)", cookies[0].Secure, tc.secure, tc.proto)
			}
			if !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
				t.Fatalf("HttpOnly/SameSite unchanged: %+v", cookies[0])
			}
		})
	}
}

// The OIDC callback's clear of the state cookie follows the same configuration
// as the cookie it clears (OIDCLogin sets it with Secure: CookieSecure).
func TestOIDCCallbackStateCookieClear_SecureFromConfig(t *testing.T) {
	mgr, err := security.NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	for _, secure := range []bool{true, false} {
		h := &AuthHandler{jwtMgr: mgr, auditStore: &memAuditStore{}, cfg: config.Config{CookieSecure: secure, OIDC: config.OIDCConfig{Enabled: true}}}
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback?state=s1&code=c1", nil)
		req.AddCookie(&http.Cookie{Name: oidcStateCookie, Value: "not-a-signed-state"})
		h.OIDCCallback(rr, req)
		var cleared *http.Cookie
		for _, c := range rr.Result().Cookies() {
			if c.Name == oidcStateCookie {
				cleared = c
			}
		}
		if cleared == nil || cleared.MaxAge >= 0 || cleared.Value != "" {
			t.Fatalf("secure=%v: state cookie not cleared: %+v", secure, cleared)
		}
		if cleared.Secure != secure {
			t.Fatalf("Secure = %v, want %v", cleared.Secure, secure)
		}
		if !cleared.HttpOnly || cleared.SameSite != http.SameSiteLaxMode || cleared.Path != "/api/v1/auth/oidc" {
			t.Fatalf("HttpOnly/SameSite/Path unchanged: %+v", cleared)
		}
	}
}
