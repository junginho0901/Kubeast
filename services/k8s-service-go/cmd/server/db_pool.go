package main

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/pkg/dbsession"
)

// envPoolMaxConns is k8s-service's pool size (the chart's postgresql.pool.k8sService.maxConns). The default is a
// fixed 10 instead of pgxpool's max(4, runtime.NumCPU()), which counts the node's CPUs (the chart sets no CPU limit),
// so the same install asked for 4 connections on one node and 64 on another.
const (
	envPoolMaxConns     = "DB_POOL_MAX_K8S"
	defaultPoolMaxConns = 10
)

// newPoolConfig is k8s-service's pool (audit rows, the cluster registry, recordings, sessions): DB_POOL_MAX_K8S
// connections (10), each with the session limits.
func newPoolConfig(dbURL string, sessionLimits dbsession.Limits) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = dbsession.PoolMaxConns(envPoolMaxConns, defaultPoolMaxConns)
	sessionLimits.Apply(&cfg.ConnConfig.Config)
	return cfg, nil
}
