package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

func (r *Repository) CreateUser(ctx context.Context, u *model.User) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO auth_users (id, name, email, team, role_id, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		u.ID, u.Name, u.Email, u.Team, u.RoleID, u.PasswordHash, u.CreatedAt, u.UpdatedAt,
	)
	return err
}

func (r *Repository) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`, email,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) GetUserByID(ctx context.Context, id string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, id,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) ListUsers(ctx context.Context, limit, offset int) ([]model.User, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.created_at, u.updated_at
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
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt); err != nil {
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

// UpdateUserProfile updates name/team fields. Nil arguments are skipped.
func (r *Repository) UpdateUserProfile(ctx context.Context, id string, name *string, team *string) error {
	sets := []string{}
	args := []interface{}{}
	idx := 1
	if name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", idx))
		args = append(args, *name)
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
