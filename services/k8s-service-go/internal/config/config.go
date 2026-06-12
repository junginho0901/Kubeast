package config

import (
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

type Config struct {
	Port    int
	Debug   bool
	AppName string

	// Kubernetes
	InCluster       bool
	KubeconfigWatch bool

	// Multi-cluster
	DeploymentMode string // "k8s" | "docker" — selects the kubeconfig Secret store
	PodNamespace   string // namespace holding per-cluster kubeconfig Secrets (k8s mode)
	KubeconfigDir  string // directory holding per-cluster kubeconfig files (docker mode)

	// Multi-cluster load / failure isolation (step 15). All have safe defaults
	// and can be tuned/disabled via env (helm values). 0 disables where noted.
	MaxClusters             int // LRU client-bundle pool size (memory bound)
	HealthcheckIntervalSec  int // periodic cluster health probe; 0 = off
	QueryCacheTTLSec        int // Prometheus query cache TTL; 0 = off (singleflight stays)
	RateLimitQPS            int // per-cluster request rate; 0 = off
	RateLimitBurst          int // per-cluster burst
	BreakerConsecutiveFails int // open the per-cluster breaker after N fails; 0 = off
	BreakerOpenSec          int // breaker open duration before half-open

	// Auth
	AuthJWKSURL    string
	JWTIssuer      string
	JWTAudience    string
	AuthCookieName string

	// CORS
	AllowedOrigins []string

	// Redis
	RedisHost string
	RedisPort int
	RedisDB   int

	// WebSocket
	WSHeartbeatInterval int

	// Postgres (shared audit log)
	DatabaseURL string
}

func Load() Config {
	return Config{
		Port:    pkgconfig.GetEnvInt("PORT", 8002),
		Debug:   pkgconfig.GetEnvBool("DEBUG", false),
		AppName: pkgconfig.GetEnv("APP_NAME", "k8s-service"),

		InCluster:       pkgconfig.GetEnvBool("IN_CLUSTER", false),
		KubeconfigWatch: pkgconfig.GetEnvBool("KUBECONFIG_WATCH", false),

		DeploymentMode: pkgconfig.GetEnv("DEPLOYMENT_MODE", "k8s"),
		PodNamespace:   pkgconfig.GetEnv("POD_NAMESPACE", "kubeast"),
		KubeconfigDir:  pkgconfig.GetEnv("KUBECONFIG_DIR", "/var/kubeast/kubeconfigs"),

		MaxClusters:             pkgconfig.GetEnvInt("MC_MAX_CLUSTERS", 20),
		HealthcheckIntervalSec:  pkgconfig.GetEnvInt("MC_HEALTHCHECK_INTERVAL_SEC", 60),
		QueryCacheTTLSec:        pkgconfig.GetEnvInt("MC_QUERY_CACHE_TTL_SEC", 30),
		RateLimitQPS:            pkgconfig.GetEnvInt("MC_RATE_LIMIT_QPS", 0),
		RateLimitBurst:          pkgconfig.GetEnvInt("MC_RATE_LIMIT_BURST", 20),
		BreakerConsecutiveFails: pkgconfig.GetEnvInt("MC_BREAKER_CONSECUTIVE_FAILS", 5),
		BreakerOpenSec:          pkgconfig.GetEnvInt("MC_BREAKER_OPEN_SEC", 30),

		AuthJWKSURL:    pkgconfig.GetEnv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		JWTIssuer:      pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience:    pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),
		AuthCookieName: pkgconfig.GetEnv("AUTH_COOKIE_NAME", "kubeast.token"),

		AllowedOrigins: pkgconfig.GetEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),

		RedisHost: pkgconfig.GetEnv("REDIS_HOST", "localhost"),
		RedisPort: pkgconfig.GetEnvInt("REDIS_PORT", 6379),
		RedisDB:   pkgconfig.GetEnvInt("REDIS_DB", 0),

		WSHeartbeatInterval: pkgconfig.GetEnvInt("WS_HEARTBEAT_INTERVAL", 30),

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubeast:password@localhost:5432/kubeast?sslmode=disable"),
	}
}

// DatabaseURLForPgx converts SQLAlchemy-style URLs (e.g. "postgresql+asyncpg://...")
// used by the rest of the stack into a form pgx understands.
func (c Config) DatabaseURLForPgx() string {
	url := c.DatabaseURL
	for _, prefix := range []string{"postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return "postgres://" + url[len(prefix):]
		}
	}
	return url
}
