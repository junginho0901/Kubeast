package handler

import (
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

// The password form's refusal of an account the provider made spends one hash check against the dummy hash, the work
// an unknown address spends, so the time of the answer does not tell such an account from a missing one. The checks
// are counted, not timed. An account the form opens spends none here: its own hash is checked after the dormant and
// lock checks. The chart's admin account is the one stored under admin.email as written, so an account the provider
// made whose address differs from it only in letter case is refused as any other.
func TestRefusingAnAccountTheProviderMadeSpendsOneCheckAgainstTheDummyHash(t *testing.T) {
	var checked []string
	h := &AuthHandler{cfg: config.Config{DefaultAdminEmail: "ops@example.com", PasswordHashIterations: 1000},
		verify: func(_, stored string) bool { checked = append(checked, stored); return false }}
	dummy := h.dummyPasswordHash()
	if dummy == "" {
		t.Fatal("no dummy hash was made")
	}

	for _, sso := range []*model.User{
		{Email: "sso@example.com", AuthSource: model.AuthSourceOIDC, PasswordHash: "pbkdf2_sha256$1000$c2FsdA$aGFzaA"},
		{Email: "Ops@Example.com", AuthSource: model.AuthSourceOIDC, PasswordHash: "pbkdf2_sha256$1000$c2FsdA$aGFzaA"},
	} {
		checked = nil
		if !h.refusesForSingleSignOn("the-password-it-was-given", sso) {
			t.Fatalf("%s, an account the provider made, was not refused", sso.Email)
		}
		if len(checked) != 1 || checked[0] != dummy {
			t.Fatalf("%s: %d hash checks (against the dummy hash: %v), want one against the dummy hash", sso.Email, len(checked), len(checked) == 1 && checked[0] == dummy)
		}
	}

	for _, u := range []*model.User{
		{Email: "pw@example.com", AuthSource: model.AuthSourcePassword},
		{Email: "ops@example.com", AuthSource: model.AuthSourceOIDC},
	} {
		checked = nil
		if h.refusesForSingleSignOn("typed", u) {
			t.Errorf("%s (%s) was refused", u.Email, u.AuthSource)
		}
		if len(checked) != 0 {
			t.Errorf("%s (%s): %d hash checks before the dormant and lock checks, want none", u.Email, u.AuthSource, len(checked))
		}
	}
}
