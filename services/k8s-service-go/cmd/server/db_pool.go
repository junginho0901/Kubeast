package main

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// newPoolConfig is k8s-service's pool (audit rows, the cluster registry, recordings, sessions): pgxpool's size
// defaults, each connection with the session limits.
func newPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	sessionLimits.Apply(&cfg.ConnConfig.Config)
	return cfg, nil
}
