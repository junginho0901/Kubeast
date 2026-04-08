package config

import (
	pkgconfig "github.com/junginho0901/kube-assistant/services/pkg/config"
)

// Config holds all configuration for the session service.
type Config struct {
	// Server
	Port int
	Debug bool

	// Database
	DatabaseURL string

	// Auth / JWT
	AuthJWKSURL string
	JWTIssuer   string
	JWTAudience string

	// CORS
	AllowedOrigins []string
}

// Load reads configuration from environment variables.
func Load() Config {
	return Config{
		Port:  pkgconfig.GetEnvInt("PORT", 8003),
		Debug: pkgconfig.GetEnvBool("DEBUG", true),

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubest:password@localhost:5432/kubest?sslmode=disable"),

		AuthJWKSURL: pkgconfig.GetEnv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		JWTIssuer:   pkgconfig.GetEnv("JWT_ISSUER", "kube-assistant-auth"),
		JWTAudience: pkgconfig.GetEnv("JWT_AUDIENCE", "kube-assistant"),

		AllowedOrigins: pkgconfig.GetEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),
	}
}

// DatabaseURLForPgx converts SQLAlchemy-style URL to pgx-compatible URL.
// Python uses "postgresql+asyncpg://..." but pgx expects "postgres://..."
func (c Config) DatabaseURLForPgx() string {
	url := c.DatabaseURL
	// Strip SQLAlchemy driver prefixes
	for _, prefix := range []string{"postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return "postgres://" + url[len(prefix):]
		}
	}
	return url
}
