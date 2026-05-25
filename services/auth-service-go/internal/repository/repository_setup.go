package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func (r *Repository) GetClusterSetup(ctx context.Context) (*model.ClusterSetup, error) {
	var cs model.ClusterSetup
	err := r.pool.QueryRow(ctx,
		`SELECT id, mode, secret_name, created_at, updated_at FROM cluster_setup ORDER BY id DESC LIMIT 1`,
	).Scan(&cs.ID, &cs.Mode, &cs.SecretName, &cs.CreatedAt, &cs.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &cs, err
}

func (r *Repository) CreateClusterSetup(ctx context.Context, mode string, secretName *string) (*model.ClusterSetup, error) {
	now := time.Now().UTC()
	var cs model.ClusterSetup
	err := r.pool.QueryRow(ctx,
		`INSERT INTO cluster_setup (mode, secret_name, created_at, updated_at) VALUES ($1, $2, $3, $4)
		 RETURNING id, mode, secret_name, created_at, updated_at`,
		mode, secretName, now, now,
	).Scan(&cs.ID, &cs.Mode, &cs.SecretName, &cs.CreatedAt, &cs.UpdatedAt)
	return &cs, err
}
