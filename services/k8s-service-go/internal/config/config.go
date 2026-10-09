package config

import (
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
	"github.com/junginho0901/kubeast/services/pkg/gitops"
	"github.com/junginho0901/kubeast/services/pkg/internalauth"
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

	// Argo CD guard (chart gitops.argocd)
	Gitops        gitops.Config
	KubeconfigDir string // directory holding per-cluster kubeconfig files (docker mode)

	// Dashboard quick actions (chart features.issues / features.optimization):
	// how many minutes of Warning events "Check issues" reads, and how many
	// hours of usage "Optimization" sizes requests from.
	IssuesEventWindowMinutes int
	OptimizationWindowHours  int

	// Cluster hygiene report (chart features.hygiene). Off = the routes answer
	// 404. A sign-off falls due every HygieneIntervalDays; the excluded
	// namespaces are left out of the workload and namespace checks; a TLS
	// certificate this close to expiry is a warning / critical finding.
	HygieneEnabled           bool
	HygieneIntervalDays      int
	HygieneExcludeNamespaces []string
	HygieneTLSWarnDays       int
	HygieneTLSCriticalDays   int

	// Log files inside containers (chart features.logFiles). Off = the routes
	// answer 404. Only files matching LogFilesPaths (absolute, glob in the file
	// name only) can be listed or read; with LogFilesNamespaces set, only pods
	// in those namespaces. LogFilesMaxLines caps the lines one read returns.
	LogFilesEnabled    bool
	LogFilesPaths      []string
	LogFilesNamespaces []string
	LogFilesMaxLines   int

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
	AuthJWKSURL string
	// AuthTokenVersionURL is auth-service's token-version lookup; the JWT
	// validator asks it so revoked tokens stop working before they expire.
	AuthTokenVersionURL string
	// InternalAPIToken authenticates the services that call the /internal
	// routes (tool-server, auth-service) — services/pkg/internalauth.
	InternalAPIToken string
	JWTIssuer        string
	JWTAudience      string
	AuthCookieName   string
	// Act as the signed-in user toward every cluster (Kubernetes impersonation).
	ImpersonationEnabled bool
	// Credential plugins a registered kubeconfig may run (exec.command base
	// names). They execute inside this pod, so only known binaries are allowed.
	KubeconfigExecCommands []string
	// Extra policy kinds ("group/plural") the Gateway → Policies page lists
	// besides the label-discovered and built-in ones (implementations that
	// neither label their CRDs nor appear in the built-in table).
	GatewayPolicyKinds []string

	// CORS
	AllowedOrigins []string

	// Redis
	RedisHost     string
	RedisPort     int
	RedisDB       int
	RedisPassword string // requirepass (REDIS_PASSWORD); empty = no AUTH

	// WebSocket
	WSHeartbeatInterval int
	// Watch subscriptions: a global cap and a per-connection cap, so one
	// browser cannot take the whole budget (second review L22).
	WSMaxSubscriptions        int
	WSMaxSubscriptionsPerConn int
	// MaxRequestBodyBytes caps every request body; YAML apply/create of large
	// manifests fit well under the default 4 MiB.
	MaxRequestBodyBytes int

	// Node shell: privileged debug pod on a node. Off unless enabled; the pod
	// always runs in NodeShellNamespace with an image from NodeShellImages.
	NodeShellEnabled    bool
	NodeShellNamespace  string
	NodeShellImages     []string
	NodeShellTimeoutSec int

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
		Gitops:         gitops.LoadFromEnv(),
		KubeconfigDir:  pkgconfig.GetEnv("KUBECONFIG_DIR", "/var/kubeast/kubeconfigs"),

		IssuesEventWindowMinutes: pkgconfig.GetEnvInt("ISSUES_EVENT_WINDOW_MINUTES", 60),
		OptimizationWindowHours:  pkgconfig.GetEnvInt("OPTIMIZATION_WINDOW_HOURS", 24),

		HygieneEnabled:           pkgconfig.GetEnvBool("HYGIENE_ENABLED", true),
		HygieneIntervalDays:      pkgconfig.GetEnvInt("HYGIENE_INTERVAL_DAYS", 30),
		HygieneExcludeNamespaces: pkgconfig.LookupEnvList("HYGIENE_EXCLUDE_NAMESPACES", "kube-system,kube-public,kube-node-lease"),
		HygieneTLSWarnDays:       pkgconfig.GetEnvInt("HYGIENE_TLS_WARN_DAYS", 30),
		HygieneTLSCriticalDays:   pkgconfig.GetEnvInt("HYGIENE_TLS_CRITICAL_DAYS", 7),

		LogFilesEnabled:    pkgconfig.GetEnvBool("LOG_FILES_ENABLED", false),
		LogFilesPaths:      pkgconfig.GetEnvList("LOG_FILES_PATHS", ""),
		LogFilesNamespaces: pkgconfig.GetEnvList("LOG_FILES_NAMESPACES", ""),
		LogFilesMaxLines:   pkgconfig.GetEnvInt("LOG_FILES_MAX_LINES", 2000),

		MaxClusters:             pkgconfig.GetEnvInt("MC_MAX_CLUSTERS", 20),
		HealthcheckIntervalSec:  pkgconfig.GetEnvInt("MC_HEALTHCHECK_INTERVAL_SEC", 60),
		QueryCacheTTLSec:        pkgconfig.GetEnvInt("MC_QUERY_CACHE_TTL_SEC", 30),
		RateLimitQPS:            pkgconfig.GetEnvInt("MC_RATE_LIMIT_QPS", 0),
		RateLimitBurst:          pkgconfig.GetEnvInt("MC_RATE_LIMIT_BURST", 20),
		BreakerConsecutiveFails: pkgconfig.GetEnvInt("MC_BREAKER_CONSECUTIVE_FAILS", 5),
		BreakerOpenSec:          pkgconfig.GetEnvInt("MC_BREAKER_OPEN_SEC", 30),

		AuthJWKSURL:         pkgconfig.GetEnv("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		AuthTokenVersionURL: pkgconfig.GetEnv("AUTH_TOKEN_VERSION_URL", "http://auth-service:8004/api/v1/auth/internal/token-version"),
		InternalAPIToken:    pkgconfig.GetEnv(internalauth.Env, ""),
		JWTIssuer:           pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience:         pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),
		AuthCookieName:      pkgconfig.GetEnv("AUTH_COOKIE_NAME", "kubeast.token"),

		ImpersonationEnabled: pkgconfig.GetEnvBool("IMPERSONATION_ENABLED", true),

		KubeconfigExecCommands: pkgconfig.GetEnvList("KUBECONFIG_EXEC_COMMANDS", cluster.DefaultExecCommands),
		GatewayPolicyKinds:     pkgconfig.GetEnvList("GATEWAY_POLICY_KINDS", ""),

		AllowedOrigins: pkgconfig.LookupEnvList("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"),

		RedisHost:     pkgconfig.GetEnv("REDIS_HOST", "localhost"),
		RedisPort:     pkgconfig.GetEnvInt("REDIS_PORT", 6379),
		RedisDB:       pkgconfig.GetEnvInt("REDIS_DB", 0),
		RedisPassword: pkgconfig.GetEnv("REDIS_PASSWORD", ""),

		WSHeartbeatInterval:       pkgconfig.GetEnvInt("WS_HEARTBEAT_INTERVAL", 30),
		WSMaxSubscriptions:        pkgconfig.GetEnvInt("WS_MAX_SUBSCRIPTIONS", 200),
		WSMaxSubscriptionsPerConn: pkgconfig.GetEnvInt("WS_MAX_SUBSCRIPTIONS_PER_CONN", 50),
		MaxRequestBodyBytes:       pkgconfig.GetEnvInt("MAX_REQUEST_BODY_BYTES", 4<<20),

		NodeShellEnabled:    pkgconfig.GetEnvBool("NODE_SHELL_ENABLED", false),
		NodeShellNamespace:  pkgconfig.GetEnv("NODE_SHELL_NAMESPACE", "kubeast-node-shell"),
		NodeShellImages:     pkgconfig.GetEnvList("NODE_SHELL_IMAGES", "docker.io/library/busybox:1.38.0"),
		NodeShellTimeoutSec: pkgconfig.GetEnvInt("NODE_SHELL_TIMEOUT_SEC", 3600),

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
