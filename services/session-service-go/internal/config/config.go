package config

import (
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
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

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubeast:password@localhost:5432/kubeast?sslmode=disable"),

		AuthJWKSURL: pkgconfig.GetEnv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		JWTIssuer:   pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience: pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),

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
