package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/accessrequests"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/auditchain"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/auditsink"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/dormant"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/retention"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
	"github.com/junginho0901/kubeast/services/pkg/limits"
	pkglogger "github.com/junginho0901/kubeast/services/pkg/logger"
	"github.com/junginho0901/kubeast/services/pkg/metrics"
)

func pingWithRetry(ctx context.Context, pool *pgxpool.Pool, attempts int, wait time.Duration) error {
	var err error
	for i := 1; i <= attempts; i++ {
		if err = pool.Ping(ctx); err == nil {
			return nil
		}
		slog.Warn("database not ready", "attempt", i, "error", err)
		time.Sleep(wait)
	}
	return err
}

func main() {
	cfg := config.Load()
	pkglogger.Setup("auth-service", cfg.Debug)
	slog.Info("starting auth-service", "port", cfg.Port)
	if err := cfg.Validate(); err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	// Database
	dbURL := cfg.DatabaseURLForPgx()
	poolCfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		slog.Error("failed to parse database URL", "error", err)
		os.Exit(1)
	}
	poolCfg.MaxConns = 20
	poolCfg.MinConns = 2

	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Postgres may still be starting in the same rollout: wait up to ~60s
	// instead of exiting into CrashLoopBackOff.
	if err := pingWithRetry(ctx, pool, 30, 2*time.Second); err != nil {
		slog.Error("failed to ping database", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to database")

	// Schema: auth-service owns the migrations (services/pkg/dbmigrate).
	// MIGRATE_ONLY=true runs them and exits (the chart's hook Job). Otherwise
	// MIGRATIONS_MODE=startup applies pending migrations here, and =job only
	// waits for the version this build needs because a Job already ran them.
	if cfg.MigrateOnly {
		v, err := dbmigrate.Up(ctx, pool)
		if err != nil {
			slog.Error("migrations failed", "error", err)
			os.Exit(1)
		}
		slog.Info("migrations applied", "version", v)
		return
	}
	if cfg.MigrationsMode == "job" {
		if err := dbmigrate.WaitFor(ctx, pool, dbmigrate.Required, 60*time.Second); err != nil {
			slog.Error("database schema not ready", "error", err)
			os.Exit(1)
		}
	} else {
		v, err := dbmigrate.Up(ctx, pool)
		if err != nil {
			slog.Error("migrations failed", "error", err)
			os.Exit(1)
		}
		slog.Info("database schema at version", "version", v)
	}

	repo := repository.New(pool)
	// Shared audit store; its table comes from the migrations above.
	pgAudit := audit.NewPostgresStore(pool, audit.ServiceAuth)
	auditStore := audit.WithStdout(pgAudit, audit.StdoutEnabled())
	slog.Info("audit writer ready", "stdout", audit.StdoutEnabled())

	// Data retention: delete audit / chat rows past their window, once now and
	// then daily; every run is audited as admin.retention.purge. Off unless a
	// window is set (RETENTION_AUDIT_DAYS / RETENTION_CHAT_DAYS).
	// Audit sinks: copies of the audit rows to S3 / webhooks / mail / a file,
	// sent by one replica (advisory lock) from each sink's cursor. A bad sinks
	// file stops the service — a silently missing archive is worse.
	sinksCfg, err := auditsink.LoadFile(cfg.AuditSinksFile, cfg.AuditSinkSecretsDir)
	if err != nil {
		slog.Error("invalid audit sinks configuration", "error", err)
		os.Exit(1)
	}
	sinkStore := auditsink.PG{Pool: pool}
	sinks, err := auditsink.New(sinksCfg, sinkStore, sinkStore)
	if err != nil {
		slog.Error("audit sinks", "error", err)
		os.Exit(1)
	}
	if names := sinks.Names(); len(names) > 0 {
		slog.Info("audit sinks configured", "sinks", names)
		go sinks.Run(ctx)
	}

	retentionCfg := retention.Config{AuditDays: cfg.RetentionAuditDays, ChatDays: cfg.RetentionChatDays, ReviewDays: cfg.RetentionReviewDays}
	if err := retentionCfg.Validate(); err != nil {
		slog.Error("invalid retention configuration", "error", err)
		os.Exit(1)
	}
	if retentionCfg.Enabled() {
		slog.Info("retention enabled", "audit_days", retentionCfg.AuditDays, "chat_days", retentionCfg.ChatDays, "review_days", retentionCfg.ReviewDays)
		purger := retention.Purger{Pool: pool, Cfg: retentionCfg, Audit: auditStore}
		if names := sinks.Names(); len(names) > 0 {
			purger.AuditFloor = func(ctx context.Context) (int64, error) { return auditsink.Floor(ctx, pool, names) }
		}
		go retention.Run(ctx, purger, 24*time.Hour)
	}

	// Temporary grants from approved access requests end on time: restore the
	// previous role, close the request, revoke the tokens, audit as system.
	// Runs whether or not requests are enabled so earlier grants still end.
	sweepEvery := time.Duration(cfg.AccessRequests.SweepSec) * time.Second
	if sweepEvery <= 0 {
		sweepEvery = time.Minute
	}
	go accessrequests.Run(ctx, accessrequests.Sweeper{Store: repo, Audit: auditStore}, sweepEvery)
	if cfg.AccessRequests.Enabled {
		slog.Info("access requests enabled", "max_hours", cfg.AccessRequests.MaxHours, "roles", cfg.AccessRequests.Roles)
	}
	if cfg.AccessReview.Enabled {
		slog.Info("access review enabled", "dormant_days", cfg.AccessReview.DormantDays, "interval_days", cfg.AccessReview.IntervalDays)
	}
	// Dormant accounts: lock accounts with no activity for Days, every
	// SweepHours. The handler's "sweep now" uses the same sweeper.
	dormantSweeper := dormant.Sweeper{Store: repo, Audit: auditStore, Days: cfg.DormantAccounts.Days, ExemptAdmins: cfg.DormantAccounts.ExemptAdmins}
	if cfg.DormantAccounts.Enabled {
		slog.Info("dormant accounts enabled", "days", cfg.DormantAccounts.Days, "sweep_hours", cfg.DormantAccounts.SweepHours, "exempt_admins", cfg.DormantAccounts.ExemptAdmins)
		go dormant.Run(ctx, dormantSweeper, time.Duration(cfg.DormantAccounts.SweepHours)*time.Hour)
	}

	// Audit log integrity: seal new audit rows into the hash chain every
	// SealSeconds and, with an anchor sink, write the chain head there every
	// AnchorHours. The handler's status / verify / "anchor now" share the store.
	if err := cfg.AuditIntegrity.Validate(); err != nil {
		slog.Error("invalid audit integrity configuration", "error", err)
		os.Exit(1)
	}
	var auditChain *handler.AuditChain
	var chainSealer *auditchain.Sealer
	var chainAnchorer *auditchain.Anchorer
	if cfg.AuditIntegrity.Enabled {
		chainStore := auditchain.PG{Pool: pool}
		chainSealer = &auditchain.Sealer{Store: chainStore}
		auditChain = &handler.AuditChain{Store: chainStore, Verifier: auditchain.Verifier{Store: chainStore}}
		if name := cfg.AuditIntegrity.AnchorSink; name != "" {
			objects, ok := sinks.ObjectStore(name)
			if !ok {
				slog.Error("audit integrity: the anchor sink is not an s3 sink in the sinks file", "sink", name)
				os.Exit(1)
			}
			chainAnchorer = &auditchain.Anchorer{Store: chainStore, Objects: objects, Sink: name, Audit: auditStore}
			auditChain.Verifier.Objects = objects
			auditChain.Anchorer = chainAnchorer
			go chainAnchorer.Run(ctx, time.Duration(cfg.AuditIntegrity.AnchorHours)*time.Hour)
		}
		go chainSealer.Run(ctx, time.Duration(cfg.AuditIntegrity.SealSeconds)*time.Second)
		slog.Info("audit integrity enabled", "seal_seconds", cfg.AuditIntegrity.SealSeconds, "anchor_sink", cfg.AuditIntegrity.AnchorSink, "anchor_hours", cfg.AuditIntegrity.AnchorHours)
	}

	// Seed system roles and migrate auth_users.role → role_id
	if err := repo.SeedSystemRoles(ctx); err != nil {
		slog.Error("failed to seed system roles", "error", err)
		os.Exit(1)
	}
	slog.Info("system roles seeded")

	// Bootstrap default users
	bootstrapUsers(ctx, repo, cfg)

	// JWT Manager
	jwtMgr, err := security.NewJWTManager(cfg.KeyDir, cfg.JWTIssuer, cfg.JWTAudience, cfg.JWTExpiresMinutes)
	if err != nil {
		slog.Error("failed to initialize JWT manager", "error", err)
		os.Exit(1)
	}
	slog.Info("JWT keys loaded")

	// Auth middleware (validates tokens using local public key, no JWKS fetch needed)
	authMiddleware := security.AuthMiddleware(jwtMgr, repo.GetTokenVersion, cfg.AuthCookieName)

	// Cluster registry: per-cluster kubeconfigs are stored as Secrets (k8s) or
	// files (docker) and read at request time, so registering a cluster never
	// requires a rollout (00-COMMON §2-4). The store is both reader (registry
	// Get) and writer (cluster CRUD / Setup).
	var secretStore cluster.SecretStore
	if cfg.DeploymentMode == "docker" {
		secretStore = cluster.NewFilesystemSecretStore(cfg.KubeconfigDir)
	} else if selfCfg, scErr := rest.InClusterConfig(); scErr == nil {
		if selfClient, scErr := kubernetes.NewForConfig(selfCfg); scErr == nil {
			secretStore = cluster.NewK8sSecretStore(selfClient, cfg.PodNamespace)
		} else {
			slog.Warn("cluster: self clientset for secret store failed", "err", scErr)
		}
	} else {
		slog.Warn("cluster: not in-cluster, kubeconfig secret store disabled (registration unavailable)", "err", scErr)
	}
	registry := cluster.NewPostgresRegistry(pool, secretStore)

	// Handlers
	authHandler := handler.NewAuthHandler(repo, jwtMgr, cfg, auditStore)
	authHandler.SetDormantSweeper(&dormantSweeper)
	authHandler.SetAuditChain(auditChain)
	roleHandler := handler.NewRoleHandler(repo, auditStore)
	setupHandler := handler.NewSetupHandler(cfg, registry, secretStore, auditStore)
	clustersHandler := handler.NewClustersHandler(registry, secretStore, auditStore, cfg)
	healthHandler := handler.NewHealthHandler(pool)

	// Router
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(audit.RealIP) // gateway-set X-Real-IP only (not chi's: it also trusts client-settable headers)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	r.Use(limits.MaxBody(int64(cfg.MaxRequestBodyBytes)))
	// Console metrics (services/pkg/metrics): request count / duration /
	// in-flight by route pattern, served at /metrics on this port.
	m := metrics.New("auth")
	m.Route = metrics.ChiRoute
	m.Registry.MustRegister(sinks.Collector())
	if chainSealer != nil {
		m.Registry.MustRegister(auditchain.Collector(chainSealer, chainAnchorer))
	}
	r.Use(m.Middleware)

	// CORS only for listed origins. With none listed the middleware is not
	// installed at all: go-chi/cors treats an empty list as "every origin",
	// and same-origin requests through the gateway need no CORS.
	if len(cfg.AllowedOrigins) > 0 {
		hasWildcard := false
		for _, o := range cfg.AllowedOrigins {
			if o == "*" {
				hasWildcard = true
				break
			}
		}
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   cfg.AllowedOrigins,
			AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"*"},
			AllowCredentials: !hasWildcard,
			MaxAge:           300,
		}))
	}

	// Health (no auth)
	r.Get("/", healthHandler.Root)
	r.Get("/health", healthHandler.Health)
	r.Get("/metrics", m.Handler().ServeHTTP)

	// Auth API
	r.Route("/api/v1/auth", func(r chi.Router) {
		// Public endpoints. The two that take credentials accept only
		// application/json bodies (login CSRF: a cross-site form cannot send
		// that content type without a preflight).
		r.With(handler.RequireJSON).Post("/register", authHandler.Register)
		r.With(handler.RequireJSON).Post("/login", authHandler.Login)
		r.Post("/logout", authHandler.Logout)
		// OIDC login (provider chosen by configuration); the session it sets is
		// the same cookie a password login sets.
		r.Get("/oidc/config", authHandler.OIDCConfig)
		r.Get("/oidc/login", authHandler.OIDCLogin)
		r.Get("/oidc/callback", authHandler.OIDCCallback)
		r.Get("/jwks.json", authHandler.JWKS)
		r.Get("/.well-known/jwks.json", authHandler.JWKS)
		// Service-to-service: the other services' validators ask for the
		// bearer's current token_version (not routed by the gateway).
		r.Get("/internal/token-version/{userID}", authHandler.TokenVersion)
		// API key → access token (Authorization: Bearer kbk_…); the gateway
		// rate-limits it like sign-in.
		r.Post("/token", authHandler.ExchangeAPIKey)

		// Setup: only "is a cluster registered yet" is public (login page routing).
		r.Get("/setup", setupHandler.GetSetupPublic)

		// Public (for registration form dropdowns)
		r.Get("/organizations", authHandler.ListOrganizations)
		r.Get("/roles", roleHandler.ListRoles)

		// Protected endpoints
		r.Group(func(r chi.Router) {
			r.Use(authMiddleware)

			// Setup wizard (admin.clusters.create, checked in the handler)
			r.Get("/setup/status", setupHandler.GetSetup)
			r.Post("/setup", setupHandler.PostSetup)
			r.Get("/setup/rollout-status", setupHandler.RolloutStatus)

			r.Get("/me", authHandler.Me)
			r.Post("/refresh", authHandler.Refresh)
			r.Post("/change-password", authHandler.ChangePassword)
			r.Get("/permissions", roleHandler.ListPermissions)

			// Admin endpoints
			r.Post("/admin/roles", roleHandler.CreateRole)
			r.Put("/admin/roles/{id}", roleHandler.UpdateRole)
			r.Delete("/admin/roles/{id}", roleHandler.DeleteRole)
			r.Post("/admin/organizations", authHandler.AdminCreateOrganization)
			r.Delete("/admin/organizations/{id}", authHandler.AdminDeleteOrganization)
			r.Get("/admin/audit-logs", authHandler.AdminListAuditLogs)
			r.Get("/admin/audit-logs/export", authHandler.AdminExportAuditLogs)
			r.Get("/admin/ai-usage", authHandler.AdminAIUsage)
			r.Post("/admin/users/bulk", authHandler.AdminBulkCreateUsers)
			r.Patch("/admin/users/bulk-role", authHandler.AdminBulkUpdateRole)
			r.Post("/admin/users", authHandler.AdminCreateUser)
			r.Get("/admin/users", authHandler.AdminListUsers)
			r.Patch("/admin/users/{user_id}", authHandler.AdminUpdateUser)
			r.Post("/admin/users/{user_id}/reset-password", authHandler.AdminResetPassword)
			r.Delete("/admin/users/{user_id}", authHandler.AdminDeleteUser)

			// Per-cluster role grants (step 08) — admin.users.update.
			r.Get("/admin/users/{user_id}/cluster-roles", authHandler.GetUserClusterRoles)
			r.Put("/admin/users/{user_id}/cluster-roles/{cluster_id}", authHandler.SetUserClusterRole)
			r.Delete("/admin/users/{user_id}/cluster-roles/{cluster_id}", authHandler.DeleteUserClusterRole)
			// Inverse view: the per-cluster access list (who has a grant on a cluster).
			r.Get("/admin/clusters/{cluster_id}/user-roles", authHandler.GetClusterUserRoles)

			// Access requests: a user asks for a higher role on a cluster for a
			// bounded time; admin.users.update approves or rejects (not their own).
			r.Get("/access-requests/config", authHandler.AccessRequestsConfig)
			r.Get("/access-requests", authHandler.ListMyAccessRequests)
			r.Post("/access-requests", authHandler.CreateAccessRequest)
			r.Delete("/access-requests/{id}", authHandler.CancelAccessRequest)
			r.Get("/admin/access-requests", authHandler.AdminListAccessRequests)
			r.Post("/admin/access-requests/{id}/approve", authHandler.AdminApproveAccessRequest)
			r.Post("/admin/access-requests/{id}/reject", authHandler.AdminRejectAccessRequest)

			// API keys: a user's own (issue, list, revoke); admin.users.update
			// lists and revokes anyone's, never issues.
			r.Get("/api-keys/config", authHandler.APIKeysConfig)
			r.Get("/api-keys", authHandler.ListMyAPIKeys)
			r.Post("/api-keys", authHandler.CreateAPIKey)
			r.Delete("/api-keys/{id}", authHandler.DeleteMyAPIKey)
			r.Get("/admin/users/{user_id}/api-keys", authHandler.AdminListUserAPIKeys)
			r.Delete("/admin/users/{user_id}/api-keys/{id}", authHandler.AdminDeleteUserAPIKey)

			// Access review: the periodic "who has what" report, its CSV and the
			// sign-off that records a review was done (admin.review.*).
			r.Get("/access-review/config", authHandler.AccessReviewConfig)
			r.Get("/admin/access-review", authHandler.AdminAccessReview)
			r.Get("/admin/access-review/export", authHandler.AdminAccessReviewExport)
			r.Post("/admin/access-review/signoff", authHandler.AdminAccessReviewSignoff)
			r.Get("/admin/access-review/history", authHandler.AdminAccessReviewHistory)
			r.Get("/admin/access-review/history/{id}", authHandler.AdminAccessReviewSnapshot)

			// Dormant accounts: the config the console reads, "sweep now" and
			// unlock (admin.users.update).
			r.Get("/dormant-accounts/config", authHandler.DormantAccountsConfig)
			r.Post("/admin/dormant-accounts/sweep", authHandler.AdminDormantSweep)
			r.Post("/admin/users/{user_id}/unlock", authHandler.AdminUnlockUser)

			// Audit log integrity: chain status, a verification run
			// (admin.audit.read) and "anchor now" (admin.audit.export).
			r.Get("/admin/audit/integrity", authHandler.AuditIntegrityStatus)
			r.Post("/admin/audit/integrity/verify", authHandler.AdminAuditVerify)
			r.Post("/admin/audit/integrity/anchor", authHandler.AdminAuditAnchor)
		})
	})

	// Multi-cluster CRUD + system info + cluster-switch audit. These live at the
	// top level (not under /api/v1/auth) and all require a valid token; the
	// admin.clusters.* permission is enforced inside each cluster handler.
	r.Group(func(r chi.Router) {
		r.Use(authMiddleware)

		r.Get("/api/v1/clusters", clustersHandler.ListClusters)
		r.Post("/api/v1/clusters", clustersHandler.RegisterCluster)
		r.Post("/api/v1/clusters/validate", clustersHandler.ValidateCluster)
		r.Delete("/api/v1/clusters/{id}", clustersHandler.DeleteCluster)
		r.Patch("/api/v1/clusters/{id}", clustersHandler.UpdateCluster)
		r.Post("/api/v1/clusters/{id}/test", clustersHandler.TestCluster)

		r.Get("/api/v1/system/deployment-mode", setupHandler.DeploymentMode)
		r.Post("/api/v1/audit/cluster-switch", authHandler.ClusterSwitch)
	})

	// Server
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		slog.Info("server listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server...")
	shutdownCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
	slog.Info("server stopped")
}

func bootstrapUsers(ctx context.Context, repo *repository.Repository, cfg config.Config) {
	if cfg.DefaultAdminPassword == "change-me-do-not-use-in-prod" {
		// Outside DEBUG the service does not start with a guessable admin
		// password: the Helm chart generates one and install-docker.sh writes
		// one into .env, so hitting this means the value was lost or removed.
		if !cfg.Debug {
			slog.Error("DEFAULT_ADMIN_PASSWORD is the built-in placeholder; refusing to start outside DEBUG — set a strong value (the Helm chart generates one)")
			os.Exit(1)
		}
		slog.Warn("DEFAULT_ADMIN_PASSWORD is the built-in placeholder; set a strong value (the Helm chart generates one)")
	}
	users := []struct {
		email, password, roleName, name string
	}{
		{cfg.DefaultAdminEmail, cfg.DefaultAdminPassword, "Admin", "admin"},
	}
	// Demo read/write accounts exist only for local development.
	if cfg.BootstrapDemoUsers {
		users = append(users,
			struct{ email, password, roleName, name string }{cfg.DefaultReadEmail, cfg.DefaultReadPassword, "Read", "read"},
			struct{ email, password, roleName, name string }{cfg.DefaultWriteEmail, cfg.DefaultWritePassword, "Write", "write"},
		)
	}

	for _, u := range users {
		existing, _ := repo.GetUserByEmail(ctx, u.email)
		if existing != nil {
			continue
		}

		role, err := repo.GetRoleByName(ctx, u.roleName)
		if err != nil || role == nil {
			slog.Error("failed to find role for bootstrap user", "email", u.email, "role", u.roleName)
			continue
		}

		hash, err := security.HashPassword(u.password, cfg.PasswordHashIterations)
		if err != nil {
			slog.Error("failed to hash bootstrap password", "email", u.email, "error", err)
			continue
		}

		now := time.Now().UTC()
		user := &model.User{
			ID:           uuid.New().String(),
			Name:         u.name,
			Email:        u.email,
			RoleID:       role.ID,
			RoleName:     role.Name,
			PasswordHash: hash,
			CreatedAt:    now,
			UpdatedAt:    now,
		}

		if err := repo.CreateUser(ctx, user); err != nil {
			slog.Error("failed to create bootstrap user", "email", u.email, "error", err)
		} else {
			slog.Info("bootstrap user created", "email", u.email, "role", u.roleName)
		}
	}
}
