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
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	pkglogger "github.com/junginho0901/kubeast/services/pkg/logger"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/session-service-go/internal/repository"
)

func main() {
	// Load config
	cfg := config.Load()

	// Setup logger
	pkglogger.Setup("session-service", cfg.Debug)
	slog.Info("starting session-service", "port", cfg.Port)

	// Connect to database
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

	// Ping database
	if err := pool.Ping(ctx); err != nil {
		slog.Error("failed to ping database", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to database")

	// Initialize schema
	repo := repository.New(pool)
	if err := repo.InitSchema(ctx); err != nil {
		slog.Error("failed to initialize schema", "error", err)
		os.Exit(1)
	}
	slog.Info("database schema initialized")

	// Setup JWT validator
	jwtValidator := auth.NewJWTValidator(auth.JWKSConfig{
		JWKSURL:  cfg.AuthJWKSURL,
		Issuer:   cfg.JWTIssuer,
		Audience: cfg.JWTAudience,
	})

	// Setup handlers
	sessionHandler := handler.NewSessionHandler(repo)
	healthHandler := handler.NewHealthHandler(pool)

	// Setup router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

	// CORS
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

	// Health endpoints (no auth)
	r.Get("/", healthHandler.Root)
	r.Get("/health", healthHandler.Health)

	// API routes (with auth)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(jwtValidator.Middleware)

		r.Get("/sessions", sessionHandler.ListSessions)
		r.Post("/sessions", sessionHandler.CreateSession)
		r.Get("/sessions/{session_id}", sessionHandler.GetSession)
		r.Patch("/sessions/{session_id}", sessionHandler.UpdateSession)
		r.Post("/sessions/{session_id}/messages", sessionHandler.SaveMessages)
		r.Delete("/sessions/{session_id}", sessionHandler.DeleteSession)
	})

	// Start server
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
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

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}
	slog.Info("server stopped")
}
