package main

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// envPoolMaxConns is session-service's pool size (the chart's postgresql.pool.sessionService.maxConns).
const (
	envPoolMaxConns     = "DB_POOL_MAX_SESSION"
	defaultPoolMaxConns = 20
)

// newPoolConfig is session-service's pool: DB_POOL_MAX_SESSION connections (20), 2 kept open, each with the session
// limits.
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
