package repository

import (
	"context"
	"fmt"
)

// The schema (tables, columns, indexes) is defined by the versioned migrations
// in services/pkg/dbmigrate and applied before this repository is used.

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

	// The legacy auth_users.role → role_id conversion lives in migration 00002.

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
