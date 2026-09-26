package config

import (
	"strings"

	"github.com/junginho0901/kubeast/services/pkg/cluster"
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

	// Account policy
	AllowRegistration  bool // self-service POST /auth/register (off: 404)
	BootstrapDemoUsers bool // create the read/write demo accounts at boot (dev only)
	PasswordMinLength  int
	// PasswordLogin: "on" (default), "admin-only" (only DefaultAdminEmail may
	// use a password — break-glass next to OIDC), "off".
	PasswordLogin string

	// OIDC login (one provider, chosen by configuration: Keycloak, Google, …).
	OIDC OIDCConfig

	// K8s setup
	SetupNamespace          string
	SetupKubeconfigSecret   string
	SetupConfigMapName      string
	SetupRestartDeployments []string

	// Deployment mode: "k8s" (default, helm/kind) or "docker" (docker-compose)
	DeploymentMode       string
	DockerKubeconfigPath string
	K8sServiceHealthURL  string
	K8sServiceURL        string
	ToolServerURL        string
	// Credential plugins a registered kubeconfig may name (exec.command base names).
	KubeconfigExecCommands []string

	// Multi-cluster: per-cluster kubeconfig stores. These MUST match the values
	// k8s-service reads from so both services agree on where kubeconfigs live.
	PodNamespace  string // namespace holding per-cluster kubeconfig Secrets (k8s mode)
	KubeconfigDir string // directory holding per-cluster kubeconfig files (docker mode)
}

// OIDCConfig is the provider-agnostic OpenID Connect client configuration.
// Any provider with discovery works; the claim names and the group→role map
// absorb the differences between them (Keycloak sends "groups", Google sends
// no groups but "hd").
type OIDCConfig struct {
	Enabled      bool
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string   // public callback URL, must match the provider registration exactly
	Scopes       []string // "openid" is always added
	EmailClaim   string
	NameClaim    string
	GroupsClaim  string
	// AllowedDomains restricts sign-in to these email domains (empty = any).
	AllowedDomains []string
	// RoleMapping maps a group claim value to an account level: Admin, Member
	// (approved; access comes from per-cluster grants) or a custom role. Read
	// and Write are per-cluster roles and are rejected here (Validate).
	RoleMapping map[string]string
	// DefaultRole is used when no group maps (Pending = an admin must approve).
	DefaultRole string
	// SyncRoles re-applies the group→role mapping on every login.
	SyncRoles bool
	// ClusterGroupPrefix: groups "<prefix><cluster-id>:<Read|Write|Admin>" grant
	// a per-cluster role.
	ClusterGroupPrefix string
	DisplayName        string
}

// parseRoleMapping reads "group=Role,group2=Role".
func parseRoleMapping(s string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(s, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		if k, v = strings.TrimSpace(k), strings.TrimSpace(v); k != "" && v != "" {
			out[k] = v
		}
	}
	return out
}

func Load() Config {
	return Config{
		PasswordLogin: pkgconfig.GetEnv("PASSWORD_LOGIN", "on"),
		OIDC: OIDCConfig{
			Enabled:            pkgconfig.GetEnvBool("OIDC_ENABLED", false),
			IssuerURL:          pkgconfig.GetEnv("OIDC_ISSUER_URL", ""),
			ClientID:           pkgconfig.GetEnv("OIDC_CLIENT_ID", ""),
			ClientSecret:       pkgconfig.GetEnv("OIDC_CLIENT_SECRET", ""),
			RedirectURL:        pkgconfig.GetEnv("OIDC_REDIRECT_URL", ""),
			Scopes:             pkgconfig.GetEnvList("OIDC_SCOPES", "openid,email,profile"),
			EmailClaim:         pkgconfig.GetEnv("OIDC_EMAIL_CLAIM", "email"),
			NameClaim:          pkgconfig.GetEnv("OIDC_NAME_CLAIM", "name"),
			GroupsClaim:        pkgconfig.GetEnv("OIDC_GROUPS_CLAIM", "groups"),
			AllowedDomains:     pkgconfig.GetEnvList("OIDC_ALLOWED_DOMAINS", ""),
			RoleMapping:        parseRoleMapping(pkgconfig.GetEnv("OIDC_ROLE_MAPPING", "")),
			DefaultRole:        pkgconfig.GetEnv("OIDC_DEFAULT_ROLE", "Pending"),
			SyncRoles:          pkgconfig.GetEnvBool("OIDC_SYNC_ROLES", true),
			ClusterGroupPrefix: pkgconfig.GetEnv("OIDC_CLUSTER_GROUP_PREFIX", "kubeast:cluster:"),
			DisplayName:        pkgconfig.GetEnv("OIDC_DISPLAY_NAME", "SSO"),
		},
		Port:  pkgconfig.GetEnvInt("PORT", 8004),
		Debug: pkgconfig.GetEnvBool("DEBUG", true),

		DatabaseURL: pkgconfig.GetEnv("DATABASE_URL", "postgres://kubeast:password@localhost:5432/kubeast?sslmode=disable"),

		JWTIssuer:         pkgconfig.GetEnv("JWT_ISSUER", "kubeast-auth"),
		JWTAudience:       pkgconfig.GetEnv("JWT_AUDIENCE", "kubeast"),
		JWTExpiresMinutes: pkgconfig.GetEnvInt("JWT_EXPIRES_MINUTES", 60),
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

		AllowRegistration:  pkgconfig.GetEnvBool("ALLOW_REGISTRATION", false),
		BootstrapDemoUsers: pkgconfig.GetEnvBool("BOOTSTRAP_DEMO_USERS", false),
		PasswordMinLength:  pkgconfig.GetEnvInt("PASSWORD_MIN_LENGTH", 12),

		SetupNamespace:          pkgconfig.GetEnv("SETUP_NAMESPACE", "kubeast"),
		SetupKubeconfigSecret:   pkgconfig.GetEnv("SETUP_KUBECONFIG_SECRET", "k8s-kubeconfig"),
		SetupConfigMapName:      pkgconfig.GetEnv("SETUP_CONFIGMAP_NAME", "kubeast-config"),
		SetupRestartDeployments: pkgconfig.GetEnvList("SETUP_RESTART_DEPLOYMENTS", "k8s-service,tool-server-admin,tool-server-write,tool-server-read"),

		DeploymentMode:       pkgconfig.GetEnv("DEPLOYMENT_MODE", "k8s"),
		DockerKubeconfigPath: pkgconfig.GetEnv("DOCKER_KUBECONFIG_PATH", "/kubeconfig/kubeconfig.yaml"),
		K8sServiceHealthURL:  pkgconfig.GetEnv("K8S_SERVICE_HEALTH_URL", "http://k8s-service:8002/health"),
		K8sServiceURL:        pkgconfig.GetEnv("K8S_SERVICE_URL", "http://k8s-service:8002"),
		// Credential plugins a registered kubeconfig may name (checked before
		// registration; k8s-service enforces the same list when it runs them).
		KubeconfigExecCommands: pkgconfig.GetEnvList("KUBECONFIG_EXEC_COMMANDS", cluster.DefaultExecCommands),
		ToolServerURL:          pkgconfig.GetEnv("TOOL_SERVER_URL", "http://tool-server:8086"),

		PodNamespace:  pkgconfig.GetEnv("POD_NAMESPACE", "kubeast"),
		KubeconfigDir: pkgconfig.GetEnv("KUBECONFIG_DIR", "/var/kubeast/kubeconfigs"),
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
