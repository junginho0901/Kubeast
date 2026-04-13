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

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/security"
	pkglogger "github.com/junginho0901/kubeast/services/pkg/logger"
)

func main() {
	cfg := config.Load()
	pkglogger.Setup("auth-service", cfg.Debug)
	slog.Info("starting auth-service", "port", cfg.Port)

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

	if err := pool.Ping(ctx); err != nil {
		slog.Error("failed to ping database", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to database")

	repo := repository.New(pool)
	if err := repo.InitSchema(ctx); err != nil {
		slog.Error("failed to initialize schema", "error", err)
		os.Exit(1)
	}
	slog.Info("database schema initialized")

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
	authMiddleware := security.AuthMiddleware(jwtMgr)

	// Handlers
	authHandler := handler.NewAuthHandler(repo, jwtMgr, cfg)
	roleHandler := handler.NewRoleHandler(repo)
	setupHandler := handler.NewSetupHandler(repo, cfg)
	healthHandler := handler.NewHealthHandler(pool)

	// Router
	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

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

	// Health (no auth)
	r.Get("/", healthHandler.Root)
	r.Get("/health", healthHandler.Health)

	// Auth API
	r.Route("/api/v1/auth", func(r chi.Router) {
		// Public endpoints
		r.Post("/register", authHandler.Register)
		r.Post("/login", authHandler.Login)
		r.Post("/logout", authHandler.Logout)
		r.Get("/jwks.json", authHandler.JWKS)
		r.Get("/.well-known/jwks.json", authHandler.JWKS)

		// Setup endpoints (no auth)
		r.Get("/setup", setupHandler.GetSetup)
		r.Post("/setup", setupHandler.PostSetup)
		r.Get("/setup/rollout-status", setupHandler.RolloutStatus)

		// Public (for registration form dropdowns)
		r.Get("/organizations", authHandler.ListOrganizations)
		r.Get("/roles", roleHandler.ListRoles)

		// Protected endpoints
		r.Group(func(r chi.Router) {
			r.Use(authMiddleware)

			r.Get("/me", authHandler.Me)
			r.Post("/change-password", authHandler.ChangePassword)
			r.Get("/permissions", roleHandler.ListPermissions)

			// Admin endpoints
			r.Post("/admin/roles", roleHandler.CreateRole)
			r.Put("/admin/roles/{id}", roleHandler.UpdateRole)
			r.Delete("/admin/roles/{id}", roleHandler.DeleteRole)
			r.Post("/admin/organizations", authHandler.AdminCreateOrganization)
			r.Delete("/admin/organizations/{id}", authHandler.AdminDeleteOrganization)
			r.Post("/admin/users/bulk", authHandler.AdminBulkCreateUsers)
			r.Patch("/admin/users/bulk-role", authHandler.AdminBulkUpdateRole)
			r.Post("/admin/users", authHandler.AdminCreateUser)
			r.Get("/admin/users", authHandler.AdminListUsers)
			r.Patch("/admin/users/{user_id}", authHandler.AdminUpdateUser)
			r.Post("/admin/users/{user_id}/reset-password", authHandler.AdminResetPassword)
			r.Delete("/admin/users/{user_id}", authHandler.AdminDeleteUser)
		})
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
	users := []struct {
		email, password, roleName, name string
	}{
		{cfg.DefaultAdminEmail, cfg.DefaultAdminPassword, "Admin", "admin"},
		{cfg.DefaultReadEmail, cfg.DefaultReadPassword, "Read", "read"},
		{cfg.DefaultWriteEmail, cfg.DefaultWritePassword, "Write", "write"},
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
