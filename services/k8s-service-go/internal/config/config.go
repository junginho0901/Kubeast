package config

import (
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

type Config struct {
	Port    int
	Debug   bool
	AppName string

	// Kubernetes
	KubeconfigPath  string
	InCluster       bool
	KubeconfigWatch bool

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
}

func Load() Config {
	return Config{
		Port:    pkgconfig.GetEnvInt("PORT", 8002),
		Debug:   pkgconfig.GetEnvBool("DEBUG", false),
		AppName: pkgconfig.GetEnv("APP_NAME", "k8s-service"),

		KubeconfigPath:  pkgconfig.GetEnv("KUBECONFIG_PATH", ""),
		InCluster:       pkgconfig.GetEnvBool("IN_CLUSTER", false),
		KubeconfigWatch: pkgconfig.GetEnvBool("KUBECONFIG_WATCH", false),

		AuthJWKSURL:    pkgconfig.GetEnv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		JWTIssuer:      pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience:    pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),
		AuthCookieName: pkgconfig.GetEnv("AUTH_COOKIE_NAME", "kubeast.token"),

		AllowedOrigins: pkgconfig.GetEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),

		RedisHost: pkgconfig.GetEnv("REDIS_HOST", "localhost"),
		RedisPort: pkgconfig.GetEnvInt("REDIS_PORT", 6379),
		RedisDB:   pkgconfig.GetEnvInt("REDIS_DB", 0),

		WSHeartbeatInterval: pkgconfig.GetEnvInt("WS_HEARTBEAT_INTERVAL", 30),
	}
}
