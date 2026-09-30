package config

import "testing"

// COOKIE_SECURE decides the Secure attribute of the session and OIDC state
// cookies. It is a deployment fact, not something to infer from a header a
// proxy may rewrite; without it, DEBUG=true (local dev over http) is the only
// case that leaves the cookies insecure.
func TestLoadCookieSecure(t *testing.T) {
	t.Run("defaults to secure when not debugging", func(t *testing.T) {
		t.Setenv("COOKIE_SECURE", "")
		t.Setenv("DEBUG", "false")
		if !Load().CookieSecure {
			t.Fatal("DEBUG=false must default COOKIE_SECURE to true")
		}
	})
	t.Run("defaults to insecure under DEBUG", func(t *testing.T) {
		t.Setenv("COOKIE_SECURE", "")
		t.Setenv("DEBUG", "true")
		if Load().CookieSecure {
			t.Fatal("DEBUG=true must default COOKIE_SECURE to false")
		}
	})
	t.Run("explicit value wins over DEBUG", func(t *testing.T) {
		t.Setenv("DEBUG", "true")
		t.Setenv("COOKIE_SECURE", "true")
		if !Load().CookieSecure {
			t.Fatal("COOKIE_SECURE=true must win")
		}
		t.Setenv("DEBUG", "false")
		t.Setenv("COOKIE_SECURE", "false")
		if Load().CookieSecure {
			t.Fatal("COOKIE_SECURE=false must win")
		}
	})
}
