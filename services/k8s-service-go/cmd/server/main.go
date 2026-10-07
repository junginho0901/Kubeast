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
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
	"github.com/junginho0901/kubeast/services/pkg/internalauth"
	"github.com/junginho0901/kubeast/services/pkg/limits"
	"github.com/junginho0901/kubeast/services/pkg/logger"
	"github.com/junginho0901/kubeast/services/pkg/metrics"
)

func main() {
	// Load configuration
	cfg := config.Load()

	// Setup structured logger
	logger.Setup(cfg.AppName, cfg.Debug)

	slog.Info("starting k8s-service-go", "port", cfg.Port, "debug", cfg.Debug)

	// The /internal routes (kubeconfig for tool-server, validate/invalidate for
	// auth-service) need the shared service token; without one they answer 503
	// and, outside DEBUG, the service does not start at all.
	if cfg.InternalAPIToken == "" {
		if !cfg.Debug {
			slog.Error("INTERNAL_API_TOKEN is not set; refusing to start outside DEBUG (the Helm chart generates one)")
			os.Exit(1)
		}
		slog.Warn("INTERNAL_API_TOKEN is not set; /internal routes will answer 503")
	}

	// Init Redis cache
	redisCache := cache.New(cfg.RedisHost, cfg.RedisPort, cfg.RedisDB, cfg.RedisPassword)

	// Shared Postgres pool: the audit log and the cluster registry.
	bootCtx, bootCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer bootCancel()
	pgPool, pgErr := pgxpool.New(bootCtx, cfg.DatabaseURLForPgx())
	if pgErr != nil {
		slog.Error("failed to create postgres pool", "error", pgErr)
		os.Exit(1)
	}
	defer pgPool.Close()

	// The audit database is a start-up requirement: wait for it (bounded by
	// AUDIT_DB_WAIT_SEC) and exit when it does not come — a restarting pod is
	// visible, a process writing audit rows to its log only is not. The schema
	// is owned by auth-service (services/pkg/dbmigrate); the audit table must be
	// at the version this build expects.
	bootWait := audit.BootWait()
	waitCtx, waitCancel := context.WithTimeout(context.Background(), bootWait)
	if err := audit.WaitReady(waitCtx, pgPool, 2*time.Second); err != nil {
		slog.Error("audit: database unavailable at boot, exiting", "waited", bootWait, "error", err)
		os.Exit(1)
	}
	if err := dbmigrate.WaitFor(waitCtx, pgPool, dbmigrate.Required, bootWait); err != nil {
		slog.Error("audit: database schema not ready, exiting", "waited", bootWait, "error", err)
		os.Exit(1)
	}
	waitCancel()
	pgStore := audit.NewPostgresStore(pgPool, audit.ServiceK8s)
	auditStore := audit.Guard(audit.WithStdout(pgStore, audit.StdoutEnabled()), pgStore, audit.FailClosedEnabled())
	slog.Info("audit: Postgres writer ready", "stdout", audit.StdoutEnabled(), "fail_closed", auditStore.FailClosed())

	// Cluster registry: per-cluster kubeconfigs are read at request time (no
	// rollout on registration). In k8s mode they live in Secrets read via the
	// in-cluster ServiceAccount; in docker mode they are files on disk.
	var secretStore cluster.SecretReader
	if cfg.DeploymentMode == "docker" {
		secretStore = cluster.NewFilesystemSecretStore(cfg.KubeconfigDir)
	} else if selfCfg, scErr := rest.InClusterConfig(); scErr == nil {
		if selfClient, scErr := kubernetes.NewForConfig(selfCfg); scErr == nil {
			secretStore = cluster.NewK8sSecretStore(selfClient, cfg.PodNamespace)
		} else {
			slog.Warn("cluster: self clientset for secret store failed", "err", scErr)
		}
	}
	registry := cluster.NewPostgresRegistry(pgPool, secretStore)

	// Init Kubernetes service (cluster-aware; starts even if unconfigured).
	startCtx, startCancel := context.WithTimeout(context.Background(), 10*time.Second)
	k8sSvc, err := k8s.NewService(startCtx, registry, cfg.KubeconfigWatch, redisCache, k8s.ServiceOptions{
		MaxClusters:    cfg.MaxClusters,
		Gitops:         cfg.Gitops,
		QueryCacheTTL:  time.Duration(cfg.QueryCacheTTLSec) * time.Second,
		RateLimitQPS:   cfg.RateLimitQPS,
		RateLimitBurst: cfg.RateLimitBurst,
		BreakerFails:   cfg.BreakerConsecutiveFails,
		BreakerOpen:    time.Duration(cfg.BreakerOpenSec) * time.Second,
		Impersonation:  cfg.ImpersonationEnabled,
		ExecCommands:   cfg.KubeconfigExecCommands,
	})
	startCancel()
	if err != nil {
		slog.Error("failed to initialize k8s service", "err", err)
		os.Exit(1)
	}
	// Init JWT validator
	jwtValidator := auth.NewJWTValidator(auth.JWKSConfig{
		JWKSURL:         cfg.AuthJWKSURL,
		Issuer:          cfg.JWTIssuer,
		Audience:        cfg.JWTAudience,
		TokenVersionURL: cfg.AuthTokenVersionURL,
	})

	// Periodic cluster health checker (step 15): keeps in-memory reachability +
	// clusters.health_status fresh so fail-fast + the picker reflect down clusters.
	if cfg.HealthcheckIntervalSec > 0 {
		hcCtx, hcCancel := context.WithCancel(context.Background())
		defer hcCancel()
		hc := k8s.NewHealthChecker(k8sSvc, registry, time.Duration(cfg.HealthcheckIntervalSec)*time.Second)
		go hc.Run(hcCtx)
	}

	// Init handler
	h := handler.New(k8sSvc, cfg, auditStore)

	// Terminal session recording (off unless SESSION_RECORDING_ENABLED): the
	// output of pod exec / node shell as asciicast, uploaded in parts while
	// the session runs. A bad configuration stops the service.
	recCfg := recording.LoadConfig()
	recorder, err := recording.New(recCfg, pgPool)
	if err != nil {
		slog.Error("invalid session recording configuration", "err", err)
		os.Exit(1)
	}
	h.SetRecorder(recorder)
	recCtx, recCancel := context.WithCancel(context.Background())
	defer recCancel()
	if recorder.Enabled() {
		slog.Info("session recording enabled", "storage", recCfg.Storage, "chunk_sec", recCfg.ChunkSeconds, "required", recCfg.Required)
		go recorder.Run(recCtx)
	}

	// Init WebSocket multiplexer
	wsMux := ws.NewMultiplexer(k8sSvc)
	wsMux.MaxSubscriptions = cfg.WSMaxSubscriptions
	wsMux.MaxSubscriptionsPerConn = cfg.WSMaxSubscriptionsPerConn

	// Console metrics (services/pkg/metrics): HTTP by route pattern, the audit
	// store's readiness and write failures, live WebSocket subscriptions.
	m := metrics.New("k8s")
	m.Route = metrics.ChiRoute
	if s, ok := any(auditStore).(audit.Statuser); ok {
		m.AuditStore(s)
	}
	m.Gauge("kubeast_ws_subscriptions", "Live WebSocket subscriptions (logs, exec, watches) across all connections.",
		func() float64 { return float64(wsMux.SubscriptionCount()) })
	if recorder.Enabled() {
		m.Gauge("kubeast_session_recording_pending_bytes", "Recorded terminal output not uploaded to the recording store yet.",
			func() float64 { return float64(recorder.PendingBytes()) })
		m.Gauge("kubeast_session_recording_last_upload_timestamp_seconds", "When a recording part was last uploaded (or when recording started).",
			func() float64 { return float64(recorder.LastSuccess()) })
		m.Registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{
			Name: "kubeast_session_recording_upload_failures_total", Help: "Failed recording part uploads since start-up.", ConstLabels: prometheus.Labels{"service": "k8s"},
		}, func() float64 { return float64(recorder.Failures()) }))
	}

	// Setup router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RequestID)
	r.Use(audit.RealIP) // gateway-set X-Real-IP only (not chi's: it also trusts client-settable headers)
	r.Use(chimiddleware.Recoverer)
	r.Use(limits.MaxBody(int64(cfg.MaxRequestBodyBytes)))
	r.Use(m.Middleware)
	// Note: no global timeout middleware - it kills WebSocket connections.
	// Individual handler timeouts are handled via context or http.Server settings.
	// CORS only for listed origins. With none listed the middleware is not
	// installed at all: go-chi/cors treats an empty list as "every origin",
	// and same-origin requests through the gateway need no CORS.
	if len(cfg.AllowedOrigins) > 0 {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   cfg.AllowedOrigins,
			AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
			AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
			ExposedHeaders:   []string{"Link"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	// Public routes
	r.Get("/", h.HealthRoot)
	r.Get("/health", h.HealthCheck)
	r.Get("/metrics", m.Handler().ServeHTTP)

	// Protected API routes — domain-specific registrations live in
	// internal/routes/. main.go retains middleware wiring only so it
	// stays small and stable across feature work.
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return jwtValidator.MiddlewareWithCookie(cfg.AuthCookieName, next)
		})
		// Resolve the target cluster from ?cluster= for every protected route
		// (+ fail-fast for clusters the health checker has marked down).
		r.Use(h.ClusterMiddleware)
		// Fail-closed: a mutation is refused (503) while the audit store cannot
		// record it. POST /search is a read. Audited GET paths check inside.
		r.Use(audit.RequireWritable(auditStore, "/api/v1/search"))
		// A write to an object an Argo CD Application manages is refused while
		// gitops.argocd.mode is "block" (the chart's default, "warn", only badges).
		if cfg.Gitops.Enabled {
			r.Use(h.GitopsGuard)
		}

		routes.Register(r, h, wsMux)
	})

	// Session recordings span clusters: JWT only, no cluster middleware; the
	// handlers check admin.sessions.read (config is open to any signed-in user).
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return jwtValidator.MiddlewareWithCookie(cfg.AuthCookieName, next)
		})
		r.Get("/api/v1/recordings/config", h.RecordingsConfig)
		r.Get("/api/v1/recordings", h.ListRecordings)
		r.Get("/api/v1/recordings/{id}", h.GetRecording)
		r.Get("/api/v1/recordings/{id}/cast", h.GetRecordingCast)
	})

	// Internal-only (NOT routed via the gateway): tool-server fetches a cluster's
	// kubeconfig at runtime so its kubectl targets the selected cluster (step 14).
	// The caller must be a known service (X-Internal-Token) AND carry the user's
	// JWT: per-cluster access and the audit actor come from the user. No
	// ClusterMiddleware — the cluster id comes from the path.
	r.Group(func(r chi.Router) {
		r.Use(internalauth.Middleware(cfg.InternalAPIToken))
		r.Use(func(next http.Handler) http.Handler {
			return jwtValidator.MiddlewareWithCookie(cfg.AuthCookieName, next)
		})
		r.Get("/internal/clusters/{id}/kubeconfig", h.GetClusterKubeconfig)
		r.Post("/internal/clusters/{id}/invalidate", h.InvalidateCluster)
		// auth-service delegates connectivity probes here so a kubeconfig's
		// credential plugin (aws-iam-authenticator) runs where the pod's cloud
		// identity is.
		r.Post("/internal/clusters/validate", h.ValidateKubeconfig)
		r.Post("/internal/clusters/{id}/validate", h.ValidateCluster)
	})

	// Create HTTP server
	// WriteTimeout=0 to support long-lived WebSocket connections
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("server listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-done
	slog.Info("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "err", err)
	}
	// End live recordings and upload what is left before the process goes.
	recorder.Shutdown(ctx)

	slog.Info("server stopped")
}
