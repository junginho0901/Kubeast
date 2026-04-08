package config

import (
	pkgconfig "github.com/junginho0901/kube-assistant/services/pkg/config"
)

type Config struct {
	Port  int
	Debug bool

	DatabaseURL string

	// JWT
	JWTIssuer         string
	JWTAudience       string
	JWTExpiresMinutes int
	KeyDir            string

	// CORS
	AllowedOrigins []string

	// Password
	PasswordHashIterations int

	// Default users
	DefaultAdminEmail    string
	DefaultAdminPassword string
	DefaultReadEmail     string
	DefaultReadPassword  string
	DefaultWriteEmail    string
	DefaultWritePassword string

	// Auth cookie
	AuthCookieName string

	// K8s setup
	SetupNamespace          string
	SetupKubeconfigSecret   string
	SetupConfigMapName      string
	SetupRestartDeployments []string
}

func Load() Config {
	return Config{
		Port:  pkgconfig.GetEnvInt("PORT", 8004),
		Debug: pkgconfig.GetEnvBool("DEBUG", true),

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubest:password@localhost:5432/kubest?sslmode=disable"),

		JWTIssuer:         pkgconfig.GetEnv("JWT_ISSUER", "kube-assistant-auth"),
		JWTAudience:       pkgconfig.GetEnv("JWT_AUDIENCE", "kube-assistant"),
		JWTExpiresMinutes: pkgconfig.GetEnvInt("JWT_EXPIRES_MINUTES", 10080),
		KeyDir:            pkgconfig.GetEnv("KEY_DIR", "/app/.keys"),

		AllowedOrigins: pkgconfig.GetEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),

		PasswordHashIterations: pkgconfig.GetEnvInt("PASSWORD_HASH_ITERATIONS", 210000),

		DefaultAdminEmail:    pkgconfig.GetEnv("DEFAULT_ADMIN_EMAIL", "admin@local"),
		DefaultAdminPassword: pkgconfig.GetEnv("DEFAULT_ADMIN_PASSWORD", "admin"),
		DefaultReadEmail:     pkgconfig.GetEnv("DEFAULT_READ_EMAIL", "read@local"),
		DefaultReadPassword:  pkgconfig.GetEnv("DEFAULT_READ_PASSWORD", "read"),
		DefaultWriteEmail:    pkgconfig.GetEnv("DEFAULT_WRITE_EMAIL", "write@local"),
		DefaultWritePassword: pkgconfig.GetEnv("DEFAULT_WRITE_PASSWORD", "write"),

		AuthCookieName: pkgconfig.GetEnv("AUTH_COOKIE_NAME", "kube-assistant.token"),

		SetupNamespace:          pkgconfig.GetEnv("SETUP_NAMESPACE", "kube-assistant"),
		SetupKubeconfigSecret:   pkgconfig.GetEnv("SETUP_KUBECONFIG_SECRET", "k8s-kubeconfig"),
		SetupConfigMapName:      pkgconfig.GetEnv("SETUP_CONFIGMAP_NAME", "kube-assistant-config"),
		SetupRestartDeployments: pkgconfig.GetEnvList("SETUP_RESTART_DEPLOYMENTS", "k8s-service,tool-server-admin,tool-server-write,tool-server-read"),
	}
}

// DatabaseURLForPgx converts SQLAlchemy-style URL to pgx-compatible URL.
func (c Config) DatabaseURLForPgx() string {
	url := c.DatabaseURL
	for _, prefix := range []string{"postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return "postgres://" + url[len(prefix):]
		}
	}
	return url
}
