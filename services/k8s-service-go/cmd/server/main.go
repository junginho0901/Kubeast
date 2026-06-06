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
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/routes"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/logger"
)

func main() {
	// Load configuration
	cfg := config.Load()

	// Setup structured logger
	logger.Setup(cfg.AppName, cfg.Debug)

	slog.Info("starting k8s-service-go", "port", cfg.Port, "debug", cfg.Debug)

	// Init Redis cache
	redisCache := cache.New(cfg.RedisHost, cfg.RedisPort, cfg.RedisDB)

	// Init shared Postgres pool (audit log) with a short timeout so that
	// a misconfigured DB does not block k8s-service start-up indefinitely.
	// On failure we fall back to the slog-backed audit store and continue.
	bootCtx, bootCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer bootCancel()

	// The pool is required for the cluster registry, so it is kept alive even
	// when the audit writer falls back to slog.
	pgPool, pgErr := pgxpool.New(bootCtx, cfg.DatabaseURLForPgx())
	if pgErr != nil {
		slog.Error("failed to create postgres pool", "error", pgErr)
		os.Exit(1)
	}
	defer pgPool.Close()

	var auditStore audit.Writer
	if err := pgPool.Ping(bootCtx); err != nil {
		slog.Warn("audit: Postgres unreachable at boot, using slog writer", "error", err)
		auditStore = audit.NewSlogStore(audit.ServiceK8s)
	} else {
		store := audit.NewPostgresStore(pgPool, audit.ServiceK8s)
		if err := store.EnsureSchema(bootCtx); err != nil {
			slog.Warn("audit: schema migration failed, using slog writer", "error", err)
			auditStore = audit.NewSlogStore(audit.ServiceK8s)
		} else {
			auditStore = store
			slog.Info("audit: Postgres writer ready")
		}
	}

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
	k8sSvc, err := k8s.NewService(startCtx, registry, cfg.KubeconfigWatch, redisCache)
	startCancel()
	if err != nil {
		slog.Error("failed to initialize k8s service", "err", err)
		os.Exit(1)
	}
	k8sSvc.SetHelmKubeconfigPath(cfg.KubeconfigPath)

	// Init JWT validator
	jwtValidator := auth.NewJWTValidator(auth.JWKSConfig{
		JWKSURL:  cfg.AuthJWKSURL,
		Issuer:   cfg.JWTIssuer,
		Audience: cfg.JWTAudience,
	})

	// Init handler
	h := handler.New(k8sSvc, cfg, auditStore)

	// Init WebSocket multiplexer
	wsMux := ws.NewMultiplexer(k8sSvc)

	// Setup router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Recoverer)
	// Note: no global timeout middleware - it kills WebSocket connections.
	// Individual handler timeouts are handled via context or http.Server settings.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Public routes
	r.Get("/", h.HealthRoot)
	r.Get("/health", h.HealthCheck)

	// Protected API routes — domain-specific registrations live in
	// internal/routes/. main.go retains middleware wiring only so it
	// stays small and stable across feature work.
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return jwtValidator.MiddlewareWithCookie(cfg.AuthCookieName, next)
		})
		// Resolve the target cluster from ?cluster= for every protected route.
		r.Use(handler.ClusterMiddleware)

		routes.Register(r, h, wsMux)
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

	slog.Info("server stopped")
}
