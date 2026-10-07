package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
)

// Access review: the reads behind the report (every user, grant and key the
// installation has) and the sign-offs that record a review was done.

// TouchLastLogin records a successful sign-in.
func (r *Repository) TouchLastLogin(ctx context.Context, userID string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `UPDATE auth_users SET last_login_at = $2 WHERE id = $1`, userID, now.UTC())
	return err
}

// ListUsersForReview returns every account with its global role, lockout and
// last sign-in, by email.
func (r *Repository) ListUsersForReview(ctx context.Context) ([]model.User, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.auth_source, u.created_at, u.updated_at,
		        u.locked_until, u.last_login_at
		   FROM auth_users u JOIN roles r ON r.id = u.role_id
		  ORDER BY u.email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.User{}
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.AuthSource, &u.CreatedAt, &u.UpdatedAt,
			&u.LockedUntil, &u.LastLoginAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ReviewClusterGrant is one active user_cluster_roles row with its names.
type ReviewClusterGrant struct {
	UserID      string
	UserEmail   string
	UserName    string
	ClusterID   string
	ClusterName string
	RoleID      int
	Role        string
	ExpiresAt   *time.Time
	RestoreRole *string
	RequestID   *string
}

// ListClusterGrantsForReview returns every active per-cluster grant.
func (r *Repository) ListClusterGrantsForReview(ctx context.Context) ([]ReviewClusterGrant, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT ucr.user_id, u.email, u.name, ucr.cluster_id, c.display_name, ucr.role_id, ro.name,
		        ucr.expires_at, rr.name, ucr.request_id
		   FROM user_cluster_roles ucr
		   JOIN auth_users u ON u.id = ucr.user_id
		   JOIN clusters c ON c.id = ucr.cluster_id
		   JOIN roles ro ON ro.id = ucr.role_id
		   LEFT JOIN roles rr ON rr.id = ucr.restore_role_id
		  WHERE `+activeGrant+`
		  ORDER BY u.email, c.display_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewClusterGrant{}
	for rows.Next() {
		var g ReviewClusterGrant
		if err := rows.Scan(&g.UserID, &g.UserEmail, &g.UserName, &g.ClusterID, &g.ClusterName, &g.RoleID, &g.Role,
			&g.ExpiresAt, &g.RestoreRole, &g.RequestID); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ReviewAPIKey is an api_keys row with its owner's email.
type ReviewAPIKey struct {
	APIKey
	OwnerEmail string
}

// ListAPIKeysForReview returns every key, by owner then creation.
func (r *Repository) ListAPIKeysForReview(ctx context.Context) ([]ReviewAPIKey, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT k.id, k.user_id, k.name, k.key_prefix, k.cluster_ids, k.role_ceiling, k.expires_at, k.last_used_at, k.last_used_ip, k.created_at, u.email
		   FROM api_keys k JOIN auth_users u ON u.id = k.user_id
		  ORDER BY u.email, k.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewAPIKey{}
	for rows.Next() {
		var k ReviewAPIKey
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.KeyPrefix, &k.ClusterIDs, &k.RoleCeiling, &k.ExpiresAt, &k.LastUsedAt, &k.LastUsedIP, &k.CreatedAt, &k.OwnerEmail); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// ListAccessRequestsSince returns the requests created at or after since,
// newest first, at most limit.
func (r *Repository) ListAccessRequestsSince(ctx context.Context, since time.Time, limit int) ([]AccessRequest, error) {
	if limit <= 0 {
		limit = 1000
	}
	rows, err := r.pool.Query(ctx,
		`SELECT `+accessRequestColumns+`
		  WHERE ar.created_at >= $1
		  ORDER BY ar.created_at DESC LIMIT $2`, since.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccessRequest{}
	for rows.Next() {
		a, err := scanAccessRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// CountUsersByRole: role id → accounts whose global role it is.
func (r *Repository) CountUsersByRole(ctx context.Context) (map[int]int, error) {
	return r.countByRole(ctx, `SELECT role_id, COUNT(*) FROM auth_users GROUP BY role_id`)
}

// CountClusterGrantsByRole: role id → active per-cluster grants carrying it.
func (r *Repository) CountClusterGrantsByRole(ctx context.Context) (map[int]int, error) {
	return r.countByRole(ctx, `SELECT role_id, COUNT(*) FROM user_cluster_roles WHERE `+activeGrant+` GROUP BY role_id`)
}

func (r *Repository) countByRole(ctx context.Context, sql string) (map[int]int, error) {
	rows, err := r.pool.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]int{}
	for rows.Next() {
		var id, n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// AccessReview is one sign-off: who reviewed, when, their note, the counts
// the report had, and (on Get) the whole report as it stood.
type AccessReview struct {
	ID              string          `json:"id"`
	ReviewedBy      *string         `json:"reviewed_by,omitempty"`
	ReviewedByEmail string          `json:"reviewed_by_email"`
	ReviewedAt      time.Time       `json:"reviewed_at"`
	Note            string          `json:"note"`
	Counts          json.RawMessage `json:"counts"`
	Snapshot        json.RawMessage `json:"snapshot,omitempty"`
}

// ErrAccessReviewNotFound: no sign-off with that id.
var ErrAccessReviewNotFound = errors.New("access review not found")

// CreateAccessReview stores a sign-off.
func (r *Repository) CreateAccessReview(ctx context.Context, rev *AccessReview) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO access_reviews (id, reviewed_by, reviewed_by_email, reviewed_at, note, counts, snapshot)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		rev.ID, rev.ReviewedBy, rev.ReviewedByEmail, rev.ReviewedAt.UTC(), rev.Note, rev.Counts, rev.Snapshot)
	return err
}

// ListAccessReviews returns sign-offs newest first, without snapshots.
func (r *Repository) ListAccessReviews(ctx context.Context, limit int) ([]AccessReview, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.pool.Query(ctx,
		`SELECT id, reviewed_by, reviewed_by_email, reviewed_at, note, counts
		   FROM access_reviews ORDER BY reviewed_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccessReview{}
	for rows.Next() {
		var a AccessReview
		if err := rows.Scan(&a.ID, &a.ReviewedBy, &a.ReviewedByEmail, &a.ReviewedAt, &a.Note, &a.Counts); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// LastAccessReview returns the newest sign-off without its snapshot, or nil.
func (r *Repository) LastAccessReview(ctx context.Context) (*AccessReview, error) {
	list, err := r.ListAccessReviews(ctx, 1)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

// GetAccessReview returns one sign-off with its snapshot.
func (r *Repository) GetAccessReview(ctx context.Context, id string) (*AccessReview, error) {
	var a AccessReview
	err := r.pool.QueryRow(ctx,
		`SELECT id, reviewed_by, reviewed_by_email, reviewed_at, note, counts, snapshot FROM access_reviews WHERE id = $1`, id,
	).Scan(&a.ID, &a.ReviewedBy, &a.ReviewedByEmail, &a.ReviewedAt, &a.Note, &a.Counts, &a.Snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAccessReviewNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}
