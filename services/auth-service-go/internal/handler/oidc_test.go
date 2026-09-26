package handler

import (
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
)

func TestOIDCStateCookie_RoundTripAndTamper(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	st := oidcState{State: "s1", Nonce: "n1", Verifier: "v1", Next: "/clusters", Exp: time.Now().Add(time.Minute).Unix()}
	cookie, err := signState(key, st)
	if err != nil {
		t.Fatal(err)
	}
	got, err := verifyState(key, cookie, time.Now())
	if err != nil || got != st {
		t.Fatalf("round trip: %v %+v", err, got)
	}
	if _, err := verifyState([]byte("other-key-other-key-other-key-00"), cookie, time.Now()); err == nil {
		t.Fatal("different key must fail")
	}
	if _, err := verifyState(key, cookie[:len(cookie)-2]+"zz", time.Now()); err == nil {
		t.Fatal("tampered signature must fail")
	}
	if _, err := verifyState(key, cookie, time.Now().Add(2*time.Minute)); err == nil {
		t.Fatal("expired state must fail")
	}
}

func TestSafeNext(t *testing.T) {
	cases := map[string]string{
		"":                      "/",
		"/clusters?x=1":         "/clusters?x=1",
		"//evil.example":        "/",
		"/\\evil.example":       "/",
		"https://evil.example/": "/",
		"clusters":              "/",
	}
	for in, want := range cases {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractClaims(t *testing.T) {
	cfg := config.OIDCConfig{EmailClaim: "email", NameClaim: "name", GroupsClaim: "groups"}
	verified := true
	c := extractClaims(map[string]any{
		"email": " Alice@Example.COM ", "email_verified": verified, "name": "Alice",
		"groups": []any{"kubeast-admins", "team-a", 7},
	}, cfg)
	if c.Email != "alice@example.com" || c.Name != "Alice" || !c.HasGroups || len(c.Groups) != 2 || c.EmailVerified == nil || !*c.EmailVerified {
		t.Fatalf("unexpected claims: %+v", c)
	}
	// a provider that sends a single group as a string, and no email_verified
	c = extractClaims(map[string]any{"email": "bob@example.com", "groups": "ops"}, cfg)
	if c.Groups[0] != "ops" || c.EmailVerified != nil {
		t.Fatalf("unexpected claims: %+v", c)
	}
	// custom claim names (Google-style preferred_username / no groups)
	c = extractClaims(map[string]any{"preferred_username": "c@example.com"}, config.OIDCConfig{EmailClaim: "preferred_username", NameClaim: "name", GroupsClaim: "groups"})
	if c.Email != "c@example.com" || c.HasGroups {
		t.Fatalf("unexpected claims: %+v", c)
	}
}

func TestDomainAllowed(t *testing.T) {
	if !domainAllowed("a@jobplanet.com", nil) {
		t.Fatal("empty allow-list allows any domain")
	}
	if !domainAllowed("a@JobPlanet.com", []string{"jobplanet.com"}) || domainAllowed("a@gmail.com", []string{"jobplanet.com"}) || domainAllowed("nodomain", []string{"jobplanet.com"}) {
		t.Fatal("domain allow-list")
	}
}

func TestMapRoleAndClusterGrants(t *testing.T) {
	mapping := map[string]string{"kubeast-admins": "Admin", "engineering": "Member", "dba": "DBA"}
	if r := mapRole([]string{"engineering", "kubeast-admins"}, mapping); r != "Admin" {
		t.Fatalf("Admin outranks Member, got %q", r)
	}
	if r := mapRole([]string{"engineering", "dba"}, mapping); r != "DBA" {
		t.Fatalf("a custom role (explicit permissions) outranks Member, got %q", r)
	}
	if r := mapRole([]string{"team-x"}, mapping); r != "" {
		t.Fatalf("no mapping → empty, got %q", r)
	}
	if r := mapRole([]string{"engineering"}, mapping); r != "Member" {
		t.Fatalf("Member, got %q", r)
	}
	g := clusterGrants([]string{"kubeast:cluster:prod:Read", "kubeast:cluster:alpha:Write", "kubeast:cluster:alpha:Admin", "kubeast:cluster:bad", "other"}, "kubeast:cluster:")
	if g["prod"] != "Read" || g["alpha"] != "Admin" || len(g) != 2 {
		t.Fatalf("cluster grants: %v", g)
	}
	if len(clusterGrants([]string{"kubeast:cluster:prod:Read"}, "")) != 0 {
		t.Fatal("empty prefix disables cluster grants")
	}
}

func TestPasswordLoginAllowed(t *testing.T) {
	cfg := config.Config{DefaultAdminEmail: "admin"}
	cfg.PasswordLogin = "on"
	if !passwordLoginAllowed(cfg, "x@example.com") {
		t.Fatal("on allows everyone")
	}
	cfg.PasswordLogin = "admin-only"
	if !passwordLoginAllowed(cfg, "Admin") || passwordLoginAllowed(cfg, "x@example.com") {
		t.Fatal("admin-only allows only the bootstrap admin")
	}
	cfg.PasswordLogin = "off"
	if passwordLoginAllowed(cfg, "admin") {
		t.Fatal("off allows nobody")
	}
}
