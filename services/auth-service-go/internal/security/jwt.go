package security

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	keyID = "auth-rs256-1"
)

// JWTManager handles RSA key pair and JWT operations.
type JWTManager struct {
	PrivateKey     *rsa.PrivateKey
	PublicKey      *rsa.PublicKey
	Issuer         string
	Audience       string
	ExpiresMinutes int
}

// NewJWTManager creates a JWTManager, loading or generating RSA keys.
func NewJWTManager(keyDir, issuer, audience string, expiresMinutes int) (*JWTManager, error) {
	privKeyPath := filepath.Join(keyDir, "jwt_private.pem")
	pubKeyPath := filepath.Join(keyDir, "jwt_public.pem")

	var privKey *rsa.PrivateKey

	// Try to load existing keys
	privPEM, err := os.ReadFile(privKeyPath)
	if err == nil {
		block, _ := pem.Decode(privPEM)
		if block != nil {
			key, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes)
			if parseErr == nil {
				if rsaKey, ok := key.(*rsa.PrivateKey); ok {
					privKey = rsaKey
				}
			}
		}
	}

	// Generate new keys if not loaded
	if privKey == nil {
		privKey, err = rsa.GenerateKey(rand.Reader, 2048)
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

		pubBytes, err := x509.MarshalPKIXPublicKey(&privKey.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("marshal public key: %w", err)
		}
		pubPEMBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})
		if err := os.WriteFile(pubKeyPath, pubPEMBlock, 0644); err != nil {
			return nil, fmt.Errorf("write public key: %w", err)
		}
	}

	return &JWTManager{
		PrivateKey:     privKey,
		PublicKey:      &privKey.PublicKey,
		Issuer:         issuer,
		Audience:       audience,
		ExpiresMinutes: expiresMinutes,
	}, nil
}

// CreateToken generates a signed JWT for a user.
func (m *JWTManager) CreateToken(userID, email, roleName string, permissions []string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":         userID,
		"email":       email,
		"role":        roleName,
		"permissions": permissions,
		"iss":         m.Issuer,
		"aud":         m.Audience,
		"iat":         now.Unix(),
		"exp":         now.Add(time.Duration(m.ExpiresMinutes) * time.Minute).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = keyID

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
				"kid": keyID,
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
