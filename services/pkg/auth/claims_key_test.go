package auth

import "testing"

// Two requests share a read only when their tokens say the same about who and what: any claim that can change a check
// changes the key, and a token renewed with the same claims keeps it.
func TestClaimsKeyDiffersWithEveryClaimThatDecidesAnAnswer(t *testing.T) {
	base := func() TokenPayload {
		return TokenPayload{
			UserID: "u1", Email: "a@example.test", Role: "read", TokenVersion: 3, APIKeyID: "", System: "",
			Perms:      PermissionMatrix{"c1": {"resource.*.read"}},
			Roles:      map[string]string{"c1": "read"},
			Namespaces: map[string][]string{"c1": {"a", "b"}},
			AuthTime:   100, ExpiresAt: 200,
		}
	}
	key := base().ClaimsKey()
	if key == "" {
		t.Fatal("no key")
	}
	renewed := base()
	renewed.AuthTime, renewed.ExpiresAt = 111, 222
	if renewed.ClaimsKey() != key {
		t.Error("a token renewed with the same claims has another key")
	}
	if base().ClaimsKey() != key {
		t.Error("the key is not stable")
	}
	for name, change := range map[string]func(*TokenPayload){
		"user":          func(p *TokenPayload) { p.UserID = "u2" },
		"email":         func(p *TokenPayload) { p.Email = "b@example.test" },
		"role claim":    func(p *TokenPayload) { p.Role = "write" },
		"a permission":  func(p *TokenPayload) { p.Perms["c1"] = []string{"resource.*.read", "resource.secret.reveal"} },
		"global key":    func(p *TokenPayload) { p.Perms["*"] = []string{"admin.audit.read"} },
		"role":          func(p *TokenPayload) { p.Roles["c1"] = "write" },
		"namespaces":    func(p *TokenPayload) { p.Namespaces["c1"] = []string{"a"} },
		"token version": func(p *TokenPayload) { p.TokenVersion = 4 },
		"api key":       func(p *TokenPayload) { p.APIKeyID = "k1" },
		"system":        func(p *TokenPayload) { p.System = SystemInvestigator },
	} {
		p := base()
		change(&p)
		if p.ClaimsKey() == key {
			t.Errorf("%s changed and the key did not", name)
		}
	}
}
