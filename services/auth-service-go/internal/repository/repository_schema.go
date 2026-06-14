package repository

import (
	"context"
	"fmt"
)

func (r *Repository) InitSchema(ctx context.Context) error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS auth_users (
			id VARCHAR PRIMARY KEY,
			name VARCHAR NOT NULL,
			email VARCHAR NOT NULL UNIQUE,
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
		// Migration: ensure team column exists; drop the retired hq column and any
		// leftover hq organizations (the org model collapsed to a single team tier).
		`DO $$ BEGIN
			ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS team VARCHAR;
			ALTER TABLE auth_users DROP COLUMN IF EXISTS hq;
			DELETE FROM organizations WHERE type = 'hq';
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
		// Multi-cluster: registry of managed clusters. Supersedes the
		// single-row cluster_setup table (which is left in place, unused).
		// The first cluster is registered fresh via Setup; no migration.
		`CREATE TABLE IF NOT EXISTS clusters (
			id                     VARCHAR PRIMARY KEY,
			display_name           VARCHAR NOT NULL,
			mode                   VARCHAR NOT NULL,
			kubeconfig_secret_name VARCHAR,
			api_server_url         VARCHAR,
			cluster_uid            VARCHAR,
			is_self_cluster        BOOLEAN NOT NULL DEFAULT FALSE,
			health_status          VARCHAR DEFAULT 'unknown',
			last_healthcheck_at    TIMESTAMP,
			created_by             VARCHAR NOT NULL DEFAULT '',
			created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_clusters_self ON clusters(is_self_cluster)`,
		// cluster_uid = kube-system namespace UID fingerprint (added after the
		// table first shipped) — rejects duplicate physical-cluster registration.
		`ALTER TABLE clusters ADD COLUMN IF NOT EXISTS cluster_uid VARCHAR`,
		`CREATE INDEX IF NOT EXISTS idx_clusters_uid ON clusters(cluster_uid)`,
		// Multi-cluster RBAC: a user gets a role per cluster. No row for a
		// (user, cluster) pair means no access to that cluster (deny-by-default).
		// admin.* users bypass this and reach every cluster.
		`CREATE TABLE IF NOT EXISTS user_cluster_roles (
			user_id    VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
			cluster_id VARCHAR NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
			role_id    INT     NOT NULL REFERENCES roles(id),
			PRIMARY KEY (user_id, cluster_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ucr_user ON user_cluster_roles(user_id)`,
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
		// Member is the approved-but-no-global-access account level: cluster access
		// comes entirely from per-cluster grants. (Read/Write/Admin below are the
		// roles assignable per-cluster; only Admin is meaningful as a GLOBAL role.)
		{"Member", "일반 사용자 (클러스터별 권한으로 접근)", nil},
		{"Read", "읽기 전용", []string{
			"menu.workloads", "menu.network", "menu.storage", "menu.security",
			"menu.cluster", "menu.gateway", "menu.gpu", "menu.helm",
			"menu.configuration", "menu.dashboard",
			"resource.*.read",
			"resource.helm.read",
		}},
		{"Write", "읽기/쓰기", []string{
			"menu.*",
			"resource.*.read", "resource.*.create", "resource.*.edit", "resource.*.delete",
			"resource.cronjob.suspend", "resource.cronjob.trigger",
			"resource.secret.reveal",
			// Helm: write role gets read + rollback + upgrade (values) + test.
			// Uninstall stays out by default — per docs/helm-plan.md §6-2
			// it requires Admin to reduce blast radius from accidental
			// production deletion.
			"resource.helm.read", "resource.helm.rollback",
			"resource.helm.upgrade", "resource.helm.test",
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

	// Collapse the global org model to account levels: a global Read/Write role is
	// meaningless (only admin.*/"*" reaches the JWT matrix), so move any user still
	// on global Read/Write to Member (approved; access comes from per-cluster
	// grants, which are untouched). Idempotent — a no-op once migrated.
	if _, err := tx.Exec(ctx,
		`UPDATE auth_users SET role_id = (SELECT id FROM roles WHERE name = 'Member')
		  WHERE role_id IN (SELECT id FROM roles WHERE name IN ('Read', 'Write'))`,
	); err != nil {
		return fmt.Errorf("collapse global read/write to member: %w", err)
	}

	return tx.Commit(ctx)
}
