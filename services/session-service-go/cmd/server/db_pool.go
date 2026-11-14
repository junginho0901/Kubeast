package main

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// newPoolConfig is session-service's pool: 20 connections, 2 kept open, each with the session limits.
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
