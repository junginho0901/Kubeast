package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kube-assistant/services/auth-service-go/internal/model"
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
	}

	for _, q := range queries {
		if _, err := r.pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("init schema: %w", err)
		}
	}
	return nil
}

// --- User operations ---

func (r *Repository) CreateUser(ctx context.Context, u *model.User) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO auth_users (id, name, email, hq, team, role, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		u.ID, u.Name, u.Email, u.HQ, u.Team, u.Role, u.PasswordHash, u.CreatedAt, u.UpdatedAt,
	)
	return err
}

func (r *Repository) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT id, name, email, hq, team, role, password_hash, created_at, updated_at
		 FROM auth_users WHERE email = $1`, email,
	).Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.Role, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) GetUserByID(ctx context.Context, id string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT id, name, email, hq, team, role, password_hash, created_at, updated_at
		 FROM auth_users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.Role, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) ListUsers(ctx context.Context, limit, offset int) ([]model.User, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, name, email, hq, team, role, password_hash, created_at, updated_at
		 FROM auth_users ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []model.User
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.HQ, &u.Team, &u.Role, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	if users == nil {
		users = []model.User{}
	}
	return users, rows.Err()
}

func (r *Repository) UpdateUserRole(ctx context.Context, id, role string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET role = $1, updated_at = $2 WHERE id = $3`,
		role, time.Now().UTC(), id,
	)
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
