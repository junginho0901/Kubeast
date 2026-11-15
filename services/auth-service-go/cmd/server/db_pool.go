package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// envPoolMaxConns is auth-service's pool size (the chart's postgresql.pool.authService.maxConns).
const (
	envPoolMaxConns     = "DB_POOL_MAX_AUTH"
	defaultPoolMaxConns = 20
)

// newPoolConfig is the pool of auth-service's requests and background jobs (and of reset-admin): DB_POOL_MAX_AUTH
// connections (20), 2 kept open, each with the session limits.
func newPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = dbsession.PoolMaxConns(envPoolMaxConns, defaultPoolMaxConns)
	cfg.MinConns = min(2, cfg.MaxConns)
	sessionLimits.Apply(&cfg.ConnConfig.Config)
	return cfg, nil
}

// newMigrationPoolConfig is the pool the schema migrations run through, without the statement and lock limits (also
// those of the role).
func newMigrationPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = dbsession.MigrationPoolMaxConns
	sessionLimits.ApplyMigrations(&cfg.ConnConfig.Config)
	return cfg, nil
}

// migrate applies the pending migrations through a pool of its own, closed when they are done.
func migrate(ctx context.Context, dbURL string, sessionLimits dbsession.Limits) (int64, error) {
	cfg, err := newMigrationPoolConfig(dbURL, sessionLimits)
	if err != nil {
		return 0, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return 0, err
	}
	defer pool.Close()
	return dbmigrate.Up(ctx, pool)
}
