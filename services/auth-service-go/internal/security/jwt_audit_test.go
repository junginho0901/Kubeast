package security

import (
	"testing"
)

func TestClaimsIgnoringExpiry(t *testing.T) {
	expired, err := NewJWTManager(t.TempDir(), "iss", "aud", -1) // already expired when issued
	if err != nil {
		t.Fatal(err)
	}
	tok, err := expired.CreateToken("u1", "u1@example.com", "Member", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := expired.ValidateToken(tok); err == nil {
		t.Fatal("an expired token must not validate")
	}
	claims, err := expired.ClaimsIgnoringExpiry(tok)
	if err != nil || claims["sub"] != "u1" || claims["email"] != "u1@example.com" {
		t.Fatalf("audit parse of an expired token: %v %v", err, claims)
	}

	// A token signed by another key is still rejected (signature is checked).
	other, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := expired.ClaimsIgnoringExpiry(mustToken(t, other)); err == nil {
		t.Fatal("a token from another key must be rejected")
	}
	if _, err := expired.ClaimsIgnoringExpiry("not-a-token"); err == nil {
		t.Fatal("garbage must be rejected")
	}
}

func mustToken(t *testing.T, m *JWTManager) string {
	t.Helper()
	tok, err := m.CreateToken("u2", "u2@example.com", "Member", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}
