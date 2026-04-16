package config

import (
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
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

	// Deployment mode: "k8s" (default, helm/kind) or "docker" (docker-compose)
	DeploymentMode       string
	DockerKubeconfigPath string
	K8sServiceHealthURL  string
}

func Load() Config {
	return Config{
		Port:  pkgconfig.GetEnvInt("PORT", 8004),
		Debug: pkgconfig.GetEnvBool("DEBUG", true),

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubeast:password@localhost:5432/kubeast?sslmode=disable"),

		JWTIssuer:         pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience:       pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),
		JWTExpiresMinutes: pkgconfig.GetEnvInt("JWT_EXPIRES_MINUTES", 10080),
		KeyDir:            pkgconfig.GetEnv("KEY_DIR", "/app/.keys"),

		AllowedOrigins: pkgconfig.GetEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),

		PasswordHashIterations: pkgconfig.GetEnvInt("PASSWORD_HASH_ITERATIONS", 210000),

		DefaultAdminEmail: pkgconfig.GetEnv("DEFAULT_ADMIN_EMAIL", "admin"),
		// 프로덕션에서는 반드시 DEFAULT_ADMIN_PASSWORD 환경변수로 강한 값을 주입하세요.
		// helm chart 는 자동으로 랜덤 생성합니다 (templates/secret.yaml 참고).
		DefaultAdminPassword: pkgconfig.GetEnv("DEFAULT_ADMIN_PASSWORD", "change-me-do-not-use-in-prod"),
		DefaultReadEmail:     pkgconfig.GetEnv("DEFAULT_READ_EMAIL", "read"),
		DefaultReadPassword:  pkgconfig.GetEnv("DEFAULT_READ_PASSWORD", "read"),
		DefaultWriteEmail:    pkgconfig.GetEnv("DEFAULT_WRITE_EMAIL", "write"),
		DefaultWritePassword: pkgconfig.GetEnv("DEFAULT_WRITE_PASSWORD", "write"),

		AuthCookieName: pkgconfig.GetEnv("AUTH_COOKIE_NAME", "kubeast.token"),

		SetupNamespace:          pkgconfig.GetEnv("SETUP_NAMESPACE", "kubeast"),
		SetupKubeconfigSecret:   pkgconfig.GetEnv("SETUP_KUBECONFIG_SECRET", "k8s-kubeconfig"),
		SetupConfigMapName:      pkgconfig.GetEnv("SETUP_CONFIGMAP_NAME", "kubeast-config"),
		SetupRestartDeployments: pkgconfig.GetEnvList("SETUP_RESTART_DEPLOYMENTS", "k8s-service,tool-server-admin,tool-server-write,tool-server-read"),

		DeploymentMode:       pkgconfig.GetEnv("DEPLOYMENT_MODE", "k8s"),
		DockerKubeconfigPath: pkgconfig.GetEnv("DOCKER_KUBECONFIG_PATH", "/kubeconfig/kubeconfig.yaml"),
		K8sServiceHealthURL:  pkgconfig.GetEnv("K8S_SERVICE_HEALTH_URL", "http://k8s-service:8002/health"),
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
