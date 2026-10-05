package repository

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// APIKey is a long-lived credential a user issues for automation (handler
// api_keys.go). Only the SHA-256 of the key is stored; KeyPrefix identifies
// the key in lists and audit rows. ClusterIDs nil means every cluster the
// user reaches at exchange time; RoleCeiling caps the role the exchanged
// token carries on each of them.
type APIKey struct {
	ID          string     `json:"id"`
	UserID      string     `json:"user_id"`
	Name        string     `json:"name"`
	KeyPrefix   string     `json:"key_prefix"`
	ClusterIDs  []string   `json:"cluster_ids"`
	RoleCeiling string     `json:"role_ceiling"`
	ExpiresAt   time.Time  `json:"expires_at"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	LastUsedIP  *string    `json:"last_used_ip,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ErrAPIKeyNotFound: no key with that hash or id (for the owner asked for).
var ErrAPIKeyNotFound = errors.New("api key not found")

const apiKeyColumns = `id, user_id, name, key_prefix, cluster_ids, role_ceiling, expires_at, last_used_at, last_used_ip, created_at`

func scanAPIKey(row pgx.Row) (*APIKey, error) {
	var k APIKey
	if err := row.Scan(&k.ID, &k.UserID, &k.Name, &k.KeyPrefix, &k.ClusterIDs, &k.RoleCeiling, &k.ExpiresAt, &k.LastUsedAt, &k.LastUsedIP, &k.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAPIKeyNotFound
		}
		return nil, err
	}
	return &k, nil
}

// CreateAPIKey stores k with the hash of its value (never the value).
func (r *Repository) CreateAPIKey(ctx context.Context, k *APIKey, keyHash string) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, cluster_ids, role_ceiling, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		k.ID, k.UserID, k.Name, keyHash, k.KeyPrefix, k.ClusterIDs, k.RoleCeiling, k.ExpiresAt)
	return err
}

// ListAPIKeys returns a user's keys, newest first.
func (r *Repository) ListAPIKeys(ctx context.Context, userID string) ([]APIKey, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+apiKeyColumns+` FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		k, err := scanAPIKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *k)
	}
	return out, rows.Err()
}

// GetAPIKeyByHash looks a presented key up by the hash of its value.
func (r *Repository) GetAPIKeyByHash(ctx context.Context, keyHash string) (*APIKey, error) {
	return scanAPIKey(r.pool.QueryRow(ctx, `SELECT `+apiKeyColumns+` FROM api_keys WHERE key_hash = $1`, keyHash))
}

// DeleteAPIKey removes key id and returns what it was (for the audit row).
// With userID set only that owner's key matches; empty userID is the admin
// path.
func (r *Repository) DeleteAPIKey(ctx context.Context, id, userID string) (*APIKey, error) {
	return scanAPIKey(r.pool.QueryRow(ctx,
		`DELETE FROM api_keys WHERE id = $1 AND ($2 = '' OR user_id = $2) RETURNING `+apiKeyColumns, id, userID))
}

// TouchAPIKey records a successful exchange.
func (r *Repository) TouchAPIKey(ctx context.Context, id, ip string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE api_keys SET last_used_at = $2, last_used_ip = NULLIF($3, '') WHERE id = $1`, id, now, ip)
	return err
}

// ListClusterIDs returns every registered cluster id — what a global
// superuser reaches without per-cluster grants.
func (r *Repository) ListClusterIDs(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `SELECT id FROM clusters ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
