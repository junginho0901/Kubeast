package security

import (
	"strings"
	"testing"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		name, pw, email string
		ok              bool
	}{
		{"ok long passphrase", "correct horse battery staple", "u@example.com", true},
		{"ok exactly min", "abcdefghijkl", "u@example.com", true},
		{"too short", "abc", "u@example.com", false},
		{"too long", strings.Repeat("x", PasswordMaxLength+1), "u@example.com", false},
		{"common value", "Password1", "u@example.com", false},
		{"common fragment inside", "MyPassword1234!", "u@example.com", false},
		{"keyboard walk inside", "qwerty-and-more-words", "u@example.com", false},
		{"equals email", "u@example.com", "u@example.com", false},
		{"equals local part (long)", "operations-team", "operations-team@example.com", false},
		{"no composition rules", "alllowercaseletters", "u@example.com", true},
	}
	for _, c := range cases {
		err := ValidatePassword(c.pw, c.email, 12)
		if c.ok && err != nil {
			t.Fatalf("%s: unexpected error %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Fatalf("%s: expected rejection", c.name)
		}
	}
}

func TestValidatePassword_MinimumFloor(t *testing.T) {
	// A misconfigured minimum below 8 is raised to 8.
	if err := ValidatePassword("1234567", "", 2); err == nil {
		t.Fatal("7 characters must be rejected even when the configured minimum is 2")
	}
	if err := ValidatePassword("abcdefghi", "", 2); err != nil {
		t.Fatalf("9 characters should pass with the floor of 8: %v", err)
	}
}
