package security

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const privateKeyFile = "jwt_private.pem"

// JWTManager handles RSA key pair and JWT operations.
type JWTManager struct {
	PrivateKey     *rsa.PrivateKey
	PublicKey      *rsa.PublicKey
	KeyID          string // RFC 7638 JWK thumbprint of the public key; changes whenever the key does
	Issuer         string
	Audience       string
	ExpiresMinutes int
}

// NewJWTManager creates a JWTManager. The private key is read from
// <keyDir>/jwt_private.pem (PKCS#8 or PKCS#1 PEM — a Secret mount in
// Kubernetes, a volume in docker-compose). When the file does not exist a key
// is generated and written there (dev / first boot on a writable volume). A
// file that exists but cannot be parsed is an error: silently generating a
// new key would invalidate every issued token.
func NewJWTManager(keyDir, issuer, audience string, expiresMinutes int) (*JWTManager, error) {
	privKeyPath := filepath.Join(keyDir, privateKeyFile)

	privKey, err := loadPrivateKey(privKeyPath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("load private key %s: %w", privKeyPath, err)
		}
		privKey, err = generatePrivateKey(keyDir, privKeyPath)
		if err != nil {
			return nil, err
		}
	}

	return &JWTManager{
		PrivateKey:     privKey,
		PublicKey:      &privKey.PublicKey,
		KeyID:          JWKThumbprint(&privKey.PublicKey),
		Issuer:         issuer,
		Audience:       audience,
		ExpiresMinutes: expiresMinutes,
	}, nil
}

func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	privPEM, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(privPEM)
	if block == nil {
		return nil, errors.New("not a PEM file")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("PKCS#8 key is not RSA")
		}
		return rsaKey, nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	return nil, errors.New("neither PKCS#8 nor PKCS#1 RSA private key")
}

func generatePrivateKey(keyDir, privKeyPath string) (*rsa.PrivateKey, error) {
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate RSA key: %w", err)
	}
	if err := os.MkdirAll(keyDir, 0700); err != nil {
		return nil, fmt.Errorf("create key dir: %w", err)
	}
	privBytes, err := x509.MarshalPKCS8PrivateKey(privKey)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	privPEMBlock := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privBytes})
	if err := os.WriteFile(privKeyPath, privPEMBlock, 0600); err != nil {
		return nil, fmt.Errorf("write private key: %w", err)
	}
	return privKey, nil
}

// JWKThumbprint returns the RFC 7638 thumbprint of an RSA public key:
// base64url(SHA-256 of the canonical JSON {"e","kty","n"}).
func JWKThumbprint(pub *rsa.PublicKey) string {
	canonical := fmt.Sprintf(`{"e":"%s","kty":"RSA","n":"%s"}`,
		b64URLUint(big.NewInt(int64(pub.E))), b64URLUint(pub.N))
	sum := sha256.Sum256([]byte(canonical))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// CreateToken generates a signed JWT for a user. permissions is the per-cluster
// permission matrix (cluster id → perms, "*" = all clusters); it marshals to a
// JSON object claim. A non-nil empty matrix marshals to {} (a valid
// deny-everything token), never null. clusterRoles ({cluster id: role name})
// becomes the "roles" claim the Kubernetes impersonation groups derive from.
// tokenVersion is the user's revocation counter ("tv" claim): bumping it in
// the database invalidates the token.
func (m *JWTManager) CreateToken(userID, email, roleName string, permissions auth.PermissionMatrix, clusterRoles map[string]string, tokenVersion int) (string, error) {
	if permissions == nil {
		permissions = auth.PermissionMatrix{}
	}
	if clusterRoles == nil {
		clusterRoles = map[string]string{}
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":         userID,
		"email":       email,
		"role":        roleName,
		"permissions": permissions,
		"roles":       clusterRoles,
		"tv":          tokenVersion,
		"jti":         uuid.NewString(), // unique per issue (login vs refresh in the same second)
		"iss":         m.Issuer,
		"aud":         m.Audience,
		"iat":         now.Unix(),
		"exp":         now.Add(time.Duration(m.ExpiresMinutes) * time.Minute).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = m.KeyID

	return token.SignedString(m.PrivateKey)
}

// ValidateToken validates a JWT and returns claims.
func (m *JWTManager) ValidateToken(tokenStr string) (jwt.MapClaims, error) {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(m.Issuer),
		jwt.WithAudience(m.Audience),
	)

	token, err := parser.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		return m.PublicKey, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

// JWKS returns the JWKS JSON response with the public key.
func (m *JWTManager) JWKS() map[string]interface{} {
	return map[string]interface{}{
		"keys": []map[string]string{
			{
				"kty": "RSA",
				"kid": m.KeyID,
				"use": "sig",
				"alg": "RS256",
				"n":   b64URLUint(m.PublicKey.N),
				"e":   b64URLUint(big.NewInt(int64(m.PublicKey.E))),
			},
		},
	}
}

func b64URLUint(val *big.Int) string {
	return base64.RawURLEncoding.EncodeToString(val.Bytes())
}
