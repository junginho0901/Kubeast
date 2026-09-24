package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

const (
	pbkdf2Alg = "pbkdf2_sha256"
	saltBytes = 16
	dkLen     = 32 // SHA256 output length
)

// HashPassword creates a PBKDF2-SHA256 hash compatible with the Python implementation.
// Format: pbkdf2_sha256$iterations$salt_b64$dk_b64
func HashPassword(password string, iterations int) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	dk := pbkdf2.Key([]byte(password), salt, iterations, dkLen, sha256.New)

	saltB64 := base64.RawURLEncoding.EncodeToString(salt)
	dkB64 := base64.RawURLEncoding.EncodeToString(dk)

	return fmt.Sprintf("%s$%d$%s$%s", pbkdf2Alg, iterations, saltB64, dkB64), nil
}

// GenerateRandomPassword returns a cryptographically random alphanumeric
// string of the requested length using crypto/rand. Used for admin
// reset-password and bootstrap fallbacks where the plaintext is shown
// to a human exactly once.
// PasswordMaxLength bounds hashing cost; NIST SP 800-63B asks for at least 64.
const PasswordMaxLength = 128

// commonPasswords is a short blocklist of values no policy should accept, and
// commonFragments are base words that make any password containing them weak
// ("password1234", "Qwerty!2026"). Not a substitute for a breached-password
// check, which needs an external source.
var commonPasswords = map[string]struct{}{
	"123456789": {}, "1234567890": {}, "admin123": {}, "administrator": {}, "welcome1": {}, "kubernetes": {},
}

var commonFragments = []string{"password", "passw0rd", "qwerty", "12345678", "letmein", "iloveyou", "changeme", "kubeast"}

// ValidatePassword applies the NIST SP 800-63B style policy: a length window,
// not the account identifier, not a well-known value. No composition rules.
func ValidatePassword(password, email string, minLength int) error {
	if minLength < 8 {
		minLength = 8
	}
	if len(password) < minLength {
		return fmt.Errorf("password must be at least %d characters", minLength)
	}
	if len(password) > PasswordMaxLength {
		return fmt.Errorf("password must be at most %d characters", PasswordMaxLength)
	}
	lower := strings.ToLower(password)
	if _, common := commonPasswords[lower]; common {
		return fmt.Errorf("password is too common")
	}
	for _, frag := range commonFragments {
		if strings.Contains(lower, frag) {
			return fmt.Errorf("password must not contain %q", frag)
		}
	}
	if e := strings.ToLower(strings.TrimSpace(email)); e != "" {
		local := e
		if at := strings.Index(e, "@"); at > 0 {
			local = e[:at]
		}
		if lower == e || lower == local {
			return fmt.Errorf("password must not be the account name")
		}
	}
	return nil
}

func GenerateRandomPassword(length int) (string, error) {
	if length <= 0 {
		length = 16
	}
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("read random: %w", err)
	}
	out := make([]byte, length)
	for i, b := range buf {
		out[i] = charset[int(b)%len(charset)]
	}
	return string(out), nil
}

// VerifyPassword checks a password against a stored PBKDF2-SHA256 hash.
// Timing-safe comparison to prevent timing attacks.
func VerifyPassword(password, stored string) bool {
	if password == "" || stored == "" {
		return false
	}

	parts := strings.SplitN(stored, "$", 4)
	if len(parts) != 4 || parts[0] != pbkdf2Alg {
		return false
	}

	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 {
		return false
	}

	salt, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}

	expected, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}

	actual := pbkdf2.Key([]byte(password), salt, iterations, len(expected), sha256.New)
	return hmac.Equal(actual, expected)
}
