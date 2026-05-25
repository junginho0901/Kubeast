package repository

import (
	"context"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func (r *Repository) ListOrganizations(ctx context.Context, orgType string) ([]model.Organization, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, type, name, created_at FROM organizations WHERE type = $1 ORDER BY name`, orgType,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orgs []model.Organization
	for rows.Next() {
		var o model.Organization
		if err := rows.Scan(&o.ID, &o.Type, &o.Name, &o.CreatedAt); err != nil {
			return nil, err
		}
		orgs = append(orgs, o)
	}
	if orgs == nil {
		orgs = []model.Organization{}
	}
	return orgs, rows.Err()
}

func (r *Repository) CreateOrganization(ctx context.Context, orgType, name string) (*model.Organization, error) {
	var o model.Organization
	err := r.pool.QueryRow(ctx,
		`INSERT INTO organizations (type, name) VALUES ($1, $2) RETURNING id, type, name, created_at`,
		orgType, name,
	).Scan(&o.ID, &o.Type, &o.Name, &o.CreatedAt)
	return &o, err
}

func (r *Repository) DeleteOrganization(ctx context.Context, id int) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, id)
	return err
}

func (r *Repository) OrganizationExists(ctx context.Context, orgType, name string) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM organizations WHERE type = $1 AND name = $2)`,
		orgType, name,
	).Scan(&exists)
	return exists, err
}
