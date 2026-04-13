package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

type Repository struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

func (r *Repository) InitSchema(ctx context.Context) error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS auth_users (
			id VARCHAR PRIMARY KEY,
			name VARCHAR NOT NULL,
			email VARCHAR NOT NULL UNIQUE,
			hq VARCHAR,
			team VARCHAR,
			role VARCHAR NOT NULL DEFAULT 'read',
			password_hash VARCHAR NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS auth_audit_logs (
			id SERIAL PRIMARY KEY,
			action VARCHAR NOT NULL,
			actor_user_id VARCHAR,
			actor_email VARCHAR,
			target_user_id VARCHAR,
			target_email VARCHAR,
			before JSONB DEFAULT '{}',
			after JSONB DEFAULT '{}',
			request_ip VARCHAR,
			user_agent VARCHAR,
			request_id VARCHAR,
			path VARCHAR,
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS cluster_setup (
			id SERIAL PRIMARY KEY,
			mode VARCHAR NOT NULL,
			secret_name VARCHAR,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS organizations (
			id SERIAL PRIMARY KEY,
			type VARCHAR NOT NULL,
			name VARCHAR NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			UNIQUE(type, name)
		)`,
		// Migration: add hq/team columns if missing
		`DO $$ BEGIN
			ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS hq VARCHAR;
			ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS team VARCHAR;
		EXCEPTION WHEN OTHERS THEN NULL;
		END $$`,
		// RBAC: roles table
		`CREATE TABLE IF NOT EXISTS roles (
			id SERIAL PRIMARY KEY,
			name VARCHAR NOT NULL UNIQUE,
			description VARCHAR NOT NULL DEFAULT '',
			is_system BOOLEAN NOT NULL DEFAULT false,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		// RBAC: role_permissions table
		`CREATE TABLE IF NOT EXISTS role_permissions (
			id SERIAL PRIMARY KEY,
			role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
			permission VARCHAR NOT NULL,
			UNIQUE(role_id, permission)
		)`,
	}

	for _, q := range queries {
		if _, err := r.pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("init schema: %w", err)
		}
	}
	return nil
}

// SeedSystemRoles ensures the four system roles exist and migrates auth_users.role → role_id.
func (r *Repository) SeedSystemRoles(ctx context.Context) error {
	type seedRole struct {
		Name        string
		Description string
		Permissions []string
	}
	seeds := []seedRole{
		{"Pending", "승인 대기", nil},
		{"Read", "읽기 전용", []string{
			"menu.workloads", "menu.network", "menu.storage", "menu.security",
			"menu.cluster", "menu.gateway", "menu.gpu", "menu.configuration", "menu.dashboard",
			"resource.*.read",
		}},
		{"Write", "읽기/쓰기", []string{
			"menu.*",
			"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete",
			"resource.cronjob.suspend", "resource.cronjob.trigger",
			"resource.secret.reveal",
			"ai.tool.*",
		}},
		{"Admin", "전체 관리자", []string{"*"}},
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("seed roles begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, s := range seeds {
		var roleID int
		err := tx.QueryRow(ctx,
			`INSERT INTO roles (name, description, is_system)
			 VALUES ($1, $2, true)
			 ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
			 RETURNING id`, s.Name, s.Description,
		).Scan(&roleID)
		if err != nil {
			return fmt.Errorf("seed role %s: %w", s.Name, err)
		}
		// Reset permissions for system roles
		if _, err := tx.Exec(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, roleID); err != nil {
			return fmt.Errorf("clear perms %s: %w", s.Name, err)
		}
		for _, p := range s.Permissions {
			if _, err := tx.Exec(ctx,
				`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
				roleID, p,
			); err != nil {
				return fmt.Errorf("insert perm %s/%s: %w", s.Name, p, err)
			}
		}
	}

	// Migrate auth_users.role string → role_id if role_id column doesn't exist yet
	var hasRoleID bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM information_schema.columns
			WHERE table_name = 'auth_users' AND column_name = 'role_id'
		)`).Scan(&hasRoleID)
	if err != nil {
		return fmt.Errorf("check role_id column: %w", err)
	}

	if !hasRoleID {
		// Add role_id column
		if _, err := tx.Exec(ctx,
			`ALTER TABLE auth_users ADD COLUMN role_id INT REFERENCES roles(id)`); err != nil {
			return fmt.Errorf("add role_id column: %w", err)
		}

		// Map existing role strings to role_id
		roleMappings := map[string]string{
			"pending": "Pending",
			"read":    "Read",
			"write":   "Write",
			"admin":   "Admin",
		}
		for oldRole, roleName := range roleMappings {
			if _, err := tx.Exec(ctx,
				`UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = $1) WHERE role = $2`,
				roleName, oldRole,
			); err != nil {
				return fmt.Errorf("migrate role %s: %w", oldRole, err)
			}
		}

		// Set any remaining NULL role_id to Read
		if _, err := tx.Exec(ctx,
			`UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Read') WHERE role_id IS NULL`,
		); err != nil {
			return fmt.Errorf("migrate null roles: %w", err)
		}

		// Make role_id NOT NULL
		if _, err := tx.Exec(ctx,
			`ALTER TABLE auth_users ALTER COLUMN role_id SET NOT NULL`); err != nil {
			return fmt.Errorf("set role_id not null: %w", err)
		}

		// Drop old role column
		if _, err := tx.Exec(ctx,
			`ALTER TABLE auth_users DROP COLUMN role`); err != nil {
			return fmt.Errorf("drop role column: %w", err)
		}
	}

	return tx.Commit(ctx)
}

// --- Role operations ---

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

// --- User operations ---

func (r *Repository) CreateUser(ctx context.Context, u *model.User) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO auth_users (id, name, email, hq, team, role_id, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		u.ID, u.Name, u.Email, u.HQ, u.Team, u.RoleID, u.PasswordHash, u.CreatedAt, u.UpdatedAt,
	)
	return err
}

func (r *Repository) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.hq, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`, email,
	).Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) GetUserByID(ctx context.Context, id string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.hq, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, id,
	).Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) ListUsers(ctx context.Context, limit, offset int) ([]model.User, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT u.id, u.name, u.email, u.hq, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id
		 ORDER BY u.created_at DESC, u.id DESC LIMIT $1 OFFSET $2`, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []model.User
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	if users == nil {
		users = []model.User{}
	}
	return users, rows.Err()
}

func (r *Repository) UpdateUserRole(ctx context.Context, id string, roleID int) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET role_id = $1, updated_at = $2 WHERE id = $3`,
		roleID, time.Now().UTC(), id,
	)
	return err
}

// UpdateUserProfile updates name/hq/team fields. Nil arguments are skipped.
func (r *Repository) UpdateUserProfile(ctx context.Context, id string, name *string, hq *string, team *string) error {
	sets := []string{}
	args := []interface{}{}
	idx := 1
	if name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", idx))
		args = append(args, *name)
		idx++
	}
	if hq != nil {
		sets = append(sets, fmt.Sprintf("hq = $%d", idx))
		// empty string → NULL so the column is cleared cleanly
		if *hq == "" {
			args = append(args, nil)
		} else {
			args = append(args, *hq)
		}
		idx++
	}
	if team != nil {
		sets = append(sets, fmt.Sprintf("team = $%d", idx))
		if *team == "" {
			args = append(args, nil)
		} else {
			args = append(args, *team)
		}
		idx++
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, fmt.Sprintf("updated_at = $%d", idx))
	args = append(args, time.Now().UTC())
	idx++
	args = append(args, id)
	query := fmt.Sprintf("UPDATE auth_users SET %s WHERE id = $%d", strings.Join(sets, ", "), idx)
	_, err := r.pool.Exec(ctx, query, args...)
	return err
}

func (r *Repository) UpdateUserPassword(ctx context.Context, id, passwordHash string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET password_hash = $1, updated_at = $2 WHERE id = $3`,
		passwordHash, time.Now().UTC(), id,
	)
	return err
}

func (r *Repository) DeleteUser(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM auth_users WHERE id = $1`, id)
	return err
}

// --- Organization operations ---

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

// --- Audit log operations ---

func (r *Repository) CreateAuditLog(ctx context.Context, log *model.AuditLog) (int, error) {
	beforeJSON, _ := json.Marshal(map[string]interface{}{})
	afterJSON, _ := json.Marshal(map[string]interface{}{})
	if log.Before != nil {
		beforeJSON = *log.Before
	}
	if log.After != nil {
		afterJSON = *log.After
	}

	var id int
	err := r.pool.QueryRow(ctx,
		`INSERT INTO auth_audit_logs (action, actor_user_id, actor_email, target_user_id, target_email, before, after, request_ip, user_agent, request_id, path, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
		log.Action, log.ActorUserID, log.ActorEmail, log.TargetUserID, log.TargetEmail,
		beforeJSON, afterJSON, log.RequestIP, log.UserAgent, log.RequestID, log.Path, time.Now().UTC(),
	).Scan(&id)
	return id, err
}

// --- Cluster setup operations ---

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
