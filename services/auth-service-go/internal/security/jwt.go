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
// becomes the "roles" claim the Kubernetes impersonation groups derive from;
// namespaces ({cluster id: [namespace…]}, scoped grants only) the "ns" claim.
// tokenVersion is the user's revocation counter ("tv" claim): bumping it in
// the database invalidates the token.
// CreateToken signs a session token for a fresh authentication (login): the
// "auth_time" claim is now.
func (m *JWTManager) CreateToken(userID, email, roleName string, permissions auth.PermissionMatrix, clusterRoles map[string]string, namespaces map[string][]string, tokenVersion int) (string, error) {
	return m.CreateTokenAt(userID, email, roleName, permissions, clusterRoles, namespaces, tokenVersion, time.Time{})
}

// CreateTokenAt signs a session token with an explicit authTime — when the
// user last proved their identity. A refresh passes the previous token's
// value through so the "auth_time" claim stays fixed and the session's
// absolute lifetime can be enforced. A zero authTime means "now".
func (m *JWTManager) CreateTokenAt(userID, email, roleName string, permissions auth.PermissionMatrix, clusterRoles map[string]string, namespaces map[string][]string, tokenVersion int, authTime time.Time) (string, error) {
	return m.sign(m.claims(userID, email, roleName, permissions, clusterRoles, namespaces, tokenVersion, authTime))
}

// CreateAPIKeyToken signs the token an API key is exchanged for: the same
// claims as a sign-in (sub = the key's owner, so token_version revocation
// applies) plus "akid", the key's id. Refresh refuses such a token.
func (m *JWTManager) CreateAPIKeyToken(userID, email, roleName string, permissions auth.PermissionMatrix, clusterRoles map[string]string, namespaces map[string][]string, tokenVersion int, apiKeyID string) (string, error) {
	claims := m.claims(userID, email, roleName, permissions, clusterRoles, namespaces, tokenVersion, time.Time{})
	claims["akid"] = apiKeyID
	return m.sign(claims)
}

// CreateInvestigatorToken signs the alert investigator's token for one
// cluster: no person behind it (sub "system", "sys": "investigator", so every
// service impersonates kubeast:investigator in the cluster), only the
// read-only AI tools there, limited to namespace when one is given, valid for
// ttl. tv is 0; the token-version route answers 0 for it while the feature is
// on and refuses once it is off.
func (m *JWTManager) CreateInvestigatorToken(clusterID, namespace string, readTools []string, ttl time.Duration) (string, error) {
	var ns map[string][]string
	if namespace != "" {
		ns = map[string][]string{clusterID: {namespace}}
	}
	claims := m.claims(InvestigatorSubject, auth.UserInvestigator, "read", auth.PermissionMatrix{clusterID: readTools}, nil, ns, 0, time.Time{})
	claims["sys"] = auth.SystemInvestigator
	claims["exp"] = time.Now().Add(ttl).Unix()
	return m.sign(claims)
}

// InvestigatorSubject is the "sub" of the investigator's token — the audit
// log's "system" actor, as for the other background work.
const InvestigatorSubject = "system"

// MaxTokenBytes bounds a signed token: it travels as the kubeast.token cookie,
// and a browser keeps at most 4096 bytes of a cookie's name, value and
// attributes (RFC 6265 §6.1). A bigger token would be dropped by the browser
// without a word, so it is refused here with an error the caller logs.
const MaxTokenBytes = 3800

// ErrTokenTooLarge is returned when a signed token passes MaxTokenBytes.
var ErrTokenTooLarge = errors.New("token too large for a browser cookie")

func (m *JWTManager) sign(claims jwt.MapClaims) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = m.KeyID
	signed, err := token.SignedString(m.PrivateKey)
	if err != nil {
		return "", err
	}
	if len(signed) > MaxTokenBytes {
		return "", fmt.Errorf("%w: %d bytes (%d clusters)", ErrTokenTooLarge, len(signed), len(asMatrix(claims["permissions"])))
	}
	return signed, nil
}

func asMatrix(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func (m *JWTManager) claims(userID, email, roleName string, permissions auth.PermissionMatrix, clusterRoles map[string]string, namespaces map[string][]string, tokenVersion int, authTime time.Time) jwt.MapClaims {
	if permissions == nil {
		permissions = auth.PermissionMatrix{}
	}
	if clusterRoles == nil {
		clusterRoles = map[string]string{}
	}
	now := time.Now()
	if authTime.IsZero() {
		authTime = now
	}
	claims := jwt.MapClaims{
		"sub":         userID,
		"email":       email,
		"role":        roleName,
		"permissions": auth.CompactPermissions(permissions),
		"roles":       clusterRoles,
		"tv":          tokenVersion,
		"auth_time":   authTime.Unix(),
		"jti":         uuid.NewString(), // unique per issue (login vs refresh in the same second)
		"iss":         m.Issuer,
		"aud":         m.Audience,
		"iat":         now.Unix(),
		"exp":         now.Add(time.Duration(m.ExpiresMinutes) * time.Minute).Unix(),
	}
	// "ns": cluster id → namespaces a grant is limited to (namespace-scoped
	// grants only; absent = every grant reaches its whole cluster).
	if len(namespaces) > 0 {
		claims["ns"] = namespaces
	}
	return claims
}

// ValidateToken validates a JWT and returns claims.
// SharedSecret derives a symmetric key from the signing key so every replica
// (they share the key Secret) can verify short-lived HMAC-signed state, such
// as the OIDC login cookie, without extra configuration.
func (m *JWTManager) SharedSecret() []byte {
	sum := sha256.Sum256(x509.MarshalPKCS1PrivateKey(m.PrivateKey))
	return sum[:]
}

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

// ClaimsIgnoringExpiry returns the claims of a token whose signature is ours,
// even when it has expired. For audit only (who is logging out), never for
// authorization: expiry, issuer and audience are not checked.
func (m *JWTManager) ClaimsIgnoringExpiry(tokenStr string) (jwt.MapClaims, error) {
	parser := jwt.NewParser(jwt.WithValidMethods([]string{"RS256"}), jwt.WithoutClaimsValidation())
	token, err := parser.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
		return m.PublicKey, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
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
