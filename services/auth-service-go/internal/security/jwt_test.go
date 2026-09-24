package security

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
)

// RFC 7638 §3.1 example key and its published thumbprint.
func TestJWKThumbprint_RFC7638Vector(t *testing.T) {
	nB64 := "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		t.Fatal(err)
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: 65537}
	if got, want := JWKThumbprint(pub), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"; got != want {
		t.Fatalf("thumbprint = %s, want %s", got, want)
	}
}

func TestNewJWTManager_GeneratesThenReloadsSameKey(t *testing.T) {
	dir := t.TempDir()
	m1, err := NewJWTManager(dir, "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	m2, err := NewJWTManager(dir, "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	if m1.KeyID != m2.KeyID || m1.PublicKey.N.Cmp(m2.PublicKey.N) != 0 {
		t.Fatalf("reloaded key differs: %s vs %s", m1.KeyID, m2.KeyID)
	}
	if m1.JWKS()["keys"].([]map[string]string)[0]["kid"] != m1.KeyID {
		t.Fatal("JWKS kid must equal manager KeyID")
	}
}

func TestNewJWTManager_DifferentKeysGetDifferentKid(t *testing.T) {
	m1, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	m2, err := NewJWTManager(t.TempDir(), "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	if m1.KeyID == m2.KeyID {
		t.Fatal("two generated keys must not share a kid")
	}
}

func TestNewJWTManager_LoadsPKCS1(t *testing.T) {
	dir := t.TempDir()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(filepath.Join(dir, privateKeyFile), pemBytes, 0600); err != nil {
		t.Fatal(err)
	}
	m, err := NewJWTManager(dir, "iss", "aud", 5)
	if err != nil {
		t.Fatal(err)
	}
	if m.PublicKey.N.Cmp(key.N) != 0 {
		t.Fatal("PKCS#1 key not loaded")
	}
}

func TestNewJWTManager_CorruptFileIsAnError(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, privateKeyFile), []byte("garbage"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewJWTManager(dir, "iss", "aud", 5); err == nil {
		t.Fatal("corrupt key file must not be silently replaced")
	}
}
