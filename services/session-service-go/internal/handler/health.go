package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// HealthHandler handles health check endpoints.
type HealthHandler struct {
	pool *pgxpool.Pool
}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler(pool *pgxpool.Pool) *HealthHandler {
	return &HealthHandler{pool: pool}
}

// Root handles GET /
func (h *HealthHandler) Root(w http.ResponseWriter, r *http.Request) {
	response.JSON(w, http.StatusOK, map[string]string{
		"service": "session-service",
		"version": "1.0.0",
		"status":  "healthy",
	})
}

// Health handles GET /health
func (h *HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	dbStatus := "disconnected"

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := h.pool.Ping(ctx); err == nil {
		dbStatus = "connected"
	} else {
		dbStatus = "error: " + err.Error()
		if len(dbStatus) > 60 {
			dbStatus = dbStatus[:60]
		}
	}

	status := "healthy"
	if dbStatus != "connected" {
		status = "degraded"
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"status":   status,
		"database": dbStatus,
	})
}
