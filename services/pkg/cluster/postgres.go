package cluster

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresRegistry is a Registry backed by the `clusters` table (owned by
// auth-service) plus a SecretReader for external clusters' kubeconfigs.
//
// When no clusters are registered yet (fresh install, before Setup) List
// returns empty and Default returns ErrNotFound; callers start unconfigured
// and connect lazily once the first cluster is registered (no env fallback,
// no rollout).
type PostgresRegistry struct {
	pool    *pgxpool.Pool
	secrets SecretReader
}

// NewPostgresRegistry builds a registry over pool, loading external kubeconfigs
// through secrets.
func NewPostgresRegistry(pool *pgxpool.Pool, secrets SecretReader) *PostgresRegistry {
	return &PostgresRegistry{pool: pool, secrets: secrets}
}

// VerifySchema reports whether the clusters table is queryable yet (auth
// service may still be creating it). Callers can back off and retry.
func (r *PostgresRegistry) VerifySchema(ctx context.Context) error {
	if _, err := r.pool.Exec(ctx, `SELECT 1 FROM clusters LIMIT 1`); err != nil {
		return fmt.Errorf("clusters schema not ready: %w", err)
	}
	return nil
}

// List returns all registered clusters (metadata only — kubeconfig blobs are
// loaded lazily by Get). Empty when nothing is registered.
func (r *PostgresRegistry) List(ctx context.Context) ([]Info, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, display_name, mode, is_self_cluster
		FROM clusters
		ORDER BY is_self_cluster DESC, display_name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Info
	for rows.Next() {
		var (
			info Info
			mode string
		)
		if err := rows.Scan(&info.ID, &info.DisplayName, &mode, &info.IsSelfCluster); err != nil {
			return nil, err
		}
		info.Mode = Mode(mode)
		if info.IsSelfCluster {
			info.InCluster = true
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// Get returns a cluster with its connection details resolved: self clusters use
// the in-cluster ServiceAccount; external clusters have their kubeconfig blob
// loaded from the secret store.
func (r *PostgresRegistry) Get(ctx context.Context, id ID) (*Info, error) {
	var (
		info       Info
		mode       string
		secretName *string
		apiURL     *string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT id, display_name, mode, kubeconfig_secret_name, api_server_url, is_self_cluster
		FROM clusters WHERE id = $1`, id,
	).Scan(&info.ID, &info.DisplayName, &mode, &secretName, &apiURL, &info.IsSelfCluster)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	info.Mode = Mode(mode)

	if info.IsSelfCluster {
		info.InCluster = true
		return &info, nil
	}
	if secretName != nil && *secretName != "" && r.secrets != nil {
		blob, err := r.secrets.ReadKubeconfig(ctx, *secretName)
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig for cluster %s: %w", id, err)
		}
		info.KubeconfigBlob = blob
	}
	return &info, nil
}

// Default returns the self cluster if any, else the oldest registered cluster.
// Returns ErrNotFound when nothing is registered (pre-Setup).
func (r *PostgresRegistry) Default(ctx context.Context) (ID, error) {
	var id ID
	err := r.pool.QueryRow(ctx, `
		SELECT id FROM clusters
		ORDER BY is_self_cluster DESC, created_at ASC
		LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return id, nil
}
