package repository

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func (r *Repository) CreateRole(ctx context.Context, name, description string, permissions []string) (*model.RoleWithPermissions, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var role model.Role
	err = tx.QueryRow(ctx,
		`INSERT INTO roles (name, description) VALUES ($1, $2)
		 RETURNING id, name, description, is_system, created_at, updated_at`,
		name, description,
	).Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt)
	if err != nil {
		return nil, err
	}

	for _, p := range permissions {
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, role.ID, p,
		); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &model.RoleWithPermissions{Role: role, Permissions: permissions}, nil
}

func (r *Repository) GetRoleByID(ctx context.Context, id int) (*model.RoleWithPermissions, error) {
	var role model.Role
	err := r.pool.QueryRow(ctx,
		`SELECT id, name, description, is_system, created_at, updated_at FROM roles WHERE id = $1`, id,
	).Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	perms, err := r.GetPermissionsByRoleID(ctx, role.ID)
	if err != nil {
		return nil, err
	}
	return &model.RoleWithPermissions{Role: role, Permissions: perms}, nil
}

func (r *Repository) GetRoleByName(ctx context.Context, name string) (*model.RoleWithPermissions, error) {
	var role model.Role
	err := r.pool.QueryRow(ctx,
		`SELECT id, name, description, is_system, created_at, updated_at FROM roles WHERE name = $1`, name,
	).Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	perms, err := r.GetPermissionsByRoleID(ctx, role.ID)
	if err != nil {
		return nil, err
	}
	return &model.RoleWithPermissions{Role: role, Permissions: perms}, nil
}

func (r *Repository) ListRoles(ctx context.Context) ([]model.RoleWithPermissions, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, name, description, is_system, created_at, updated_at FROM roles ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var roles []model.RoleWithPermissions
	for rows.Next() {
		var role model.Role
		if err := rows.Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt); err != nil {
			return nil, err
		}
		perms, err := r.GetPermissionsByRoleID(ctx, role.ID)
		if err != nil {
			return nil, err
		}
		roles = append(roles, model.RoleWithPermissions{Role: role, Permissions: perms})
	}
	if roles == nil {
		roles = []model.RoleWithPermissions{}
	}
	return roles, rows.Err()
}

func (r *Repository) UpdateRole(ctx context.Context, id int, name, description string, permissions []string) (*model.RoleWithPermissions, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var role model.Role
	err = tx.QueryRow(ctx,
		`UPDATE roles SET name = $1, description = $2, updated_at = NOW()
		 WHERE id = $3
		 RETURNING id, name, description, is_system, created_at, updated_at`,
		name, description, id,
	).Scan(&role.ID, &role.Name, &role.Description, &role.IsSystem, &role.CreatedAt, &role.UpdatedAt)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, id); err != nil {
		return nil, err
	}
	for _, p := range permissions {
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, id, p,
		); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &model.RoleWithPermissions{Role: role, Permissions: permissions}, nil
}

func (r *Repository) DeleteRole(ctx context.Context, id int) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM roles WHERE id = $1 AND is_system = false`, id)
	return err
}

func (r *Repository) GetPermissionsByRoleID(ctx context.Context, roleID int) ([]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission`, roleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var perms []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		perms = append(perms, p)
	}
	if perms == nil {
		perms = []string{}
	}
	return perms, rows.Err()
}
