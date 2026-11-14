package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbmigrate"
	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// newPoolConfig is the pool of auth-service's requests and background jobs (and of reset-admin): 20 connections,
// 2 kept open, each with the session limits.
func newPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	sessionLimits.Apply(&cfg.ConnConfig.Config)
	return cfg, nil
}

// newMigrationPoolConfig is the pool the schema migrations run through, without the statement and lock limits.
func newMigrationPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
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
