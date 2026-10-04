package repository

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Access requests: a user asks for a higher role on a cluster they already
// reach, for a bounded time; an admin approves or rejects. An approval turns
// the user's grant into a temporary one (expires_at / restore_role_id on
// user_cluster_roles) that the sweeper reverts when it passes.

// Request statuses.
const (
	AccessRequestPending   = "pending"
	AccessRequestApproved  = "approved"
	AccessRequestRejected  = "rejected"
	AccessRequestCancelled = "cancelled"
	AccessRequestExpired   = "expired"
)

// Why an approved (or pending) request ended — access_requests.end_reason.
const (
	EndReasonExpired     = "expired"      // the granted time passed
	EndReasonNotReviewed = "not_reviewed" // pending for longer than the request TTL
	EndReasonRevoked     = "revoked"      // an admin revoked the grant
	EndReasonSuperseded  = "superseded"   // an admin set the role by hand
)

// ErrAccessRequestNotPending is returned by a decision or cancel on a request
// that is no longer pending.
var ErrAccessRequestNotPending = errors.New("access request is not pending")

// AccessRequest is one access_requests row joined with the names the UI shows.
type AccessRequest struct {
	ID              string     `json:"id"`
	UserID          string     `json:"user_id"`
	UserEmail       string     `json:"user_email"`
	UserName        string     `json:"user_name"`
	ClusterID       string     `json:"cluster_id"`
	ClusterName     string     `json:"cluster_name"`
	RoleID          int        `json:"-"`
	Role            string     `json:"role"`
	DurationMinutes int        `json:"duration_minutes"`
	Reason          string     `json:"reason"`
	Status          string     `json:"status"`
	CreatedAt       time.Time  `json:"created_at"`
	DecidedBy       *string    `json:"decided_by,omitempty"`
	DecidedByEmail  *string    `json:"decided_by_email,omitempty"`
	DecidedAt       *time.Time `json:"decided_at,omitempty"`
	DecisionNote    *string    `json:"decision_note,omitempty"`
	ExpiresAt       *time.Time `json:"expires_at,omitempty"`
	EndedAt         *time.Time `json:"ended_at,omitempty"`
	EndReason       *string    `json:"end_reason,omitempty"`
}

const accessRequestColumns = `
	ar.id, ar.user_id, u.email, u.name, ar.cluster_id, c.display_name, ar.role_id, ro.name,
	ar.duration_minutes, ar.reason, ar.status, ar.created_at,
	ar.decided_by, d.email, ar.decided_at, ar.decision_note, ar.expires_at, ar.ended_at, ar.end_reason
	FROM access_requests ar
	JOIN auth_users u ON u.id = ar.user_id
	JOIN clusters c ON c.id = ar.cluster_id
	JOIN roles ro ON ro.id = ar.role_id
	LEFT JOIN auth_users d ON d.id = ar.decided_by`

func scanAccessRequest(row pgx.Row) (*AccessRequest, error) {
	var a AccessRequest
	err := row.Scan(&a.ID, &a.UserID, &a.UserEmail, &a.UserName, &a.ClusterID, &a.ClusterName, &a.RoleID, &a.Role,
		&a.DurationMinutes, &a.Reason, &a.Status, &a.CreatedAt,
		&a.DecidedBy, &a.DecidedByEmail, &a.DecidedAt, &a.DecisionNote, &a.ExpiresAt, &a.EndedAt, &a.EndReason)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// CreateAccessRequest stores a new pending request.
func (r *Repository) CreateAccessRequest(ctx context.Context, id, userID, clusterID string, roleID, durationMinutes int, reason string) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		id, userID, clusterID, roleID, durationMinutes, reason)
	return err
}

// GetAccessRequest returns one request, or nil when it does not exist.
func (r *Repository) GetAccessRequest(ctx context.Context, id string) (*AccessRequest, error) {
	a, err := scanAccessRequest(r.pool.QueryRow(ctx, `SELECT `+accessRequestColumns+` WHERE ar.id = $1`, id))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return a, err
}

// AccessRequestFilter narrows ListAccessRequests. Empty fields are ignored.
type AccessRequestFilter struct {
	UserID string
	Status string
	Limit  int
}

// ListAccessRequests returns requests newest first.
func (r *Repository) ListAccessRequests(ctx context.Context, f AccessRequestFilter) ([]AccessRequest, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.pool.Query(ctx,
		`SELECT `+accessRequestColumns+`
		  WHERE ($1 = '' OR ar.user_id = $1) AND ($2 = '' OR ar.status = $2)
		  ORDER BY ar.created_at DESC LIMIT $3`, f.UserID, f.Status, limit)
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

// HasPendingAccessRequest reports whether the user already has a pending
// request on the cluster (one at a time).
func (r *Repository) HasPendingAccessRequest(ctx context.Context, userID, clusterID string) (bool, error) {
	var n int
	err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM access_requests WHERE user_id = $1 AND cluster_id = $2 AND status = $3`,
		userID, clusterID, AccessRequestPending).Scan(&n)
	return n > 0, err
}

// CancelAccessRequest withdraws the requester's own pending request. Returns
// ErrAccessRequestNotPending when the row is not theirs or not pending.
func (r *Repository) CancelAccessRequest(ctx context.Context, id, userID string, now time.Time) error {
	tag, err := r.pool.Exec(ctx,
		`UPDATE access_requests SET status = $4, ended_at = $3
		  WHERE id = $1 AND user_id = $2 AND status = $5`,
		id, userID, now.UTC(), AccessRequestCancelled, AccessRequestPending)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccessRequestNotPending
	}
	return nil
}

// RejectAccessRequest records a rejection of a pending request.
func (r *Repository) RejectAccessRequest(ctx context.Context, id, deciderID, note string, now time.Time) error {
	tag, err := r.pool.Exec(ctx,
		`UPDATE access_requests SET status = $5, decided_by = $2, decided_at = $3, decision_note = $4, ended_at = $3
		  WHERE id = $1 AND status = $6`,
		id, deciderID, now.UTC(), nullIfEmpty(note), AccessRequestRejected, AccessRequestPending)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAccessRequestNotPending
	}
	return nil
}

// ApproveAccessRequest grants the requested role for the requested time and
// marks the request approved, in one transaction. The user's current grant
// on the cluster (if any) is remembered in restore_role_id and comes back
// when the grant expires. Returns the grant's expiry.
func (r *Repository) ApproveAccessRequest(ctx context.Context, id, deciderID, note string, now time.Time) (time.Time, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback(ctx)

	var userID, clusterID string
	var roleID, minutes int
	err = tx.QueryRow(ctx,
		`SELECT user_id, cluster_id, role_id, duration_minutes FROM access_requests
		  WHERE id = $1 AND status = $2 FOR UPDATE`, id, AccessRequestPending).
		Scan(&userID, &clusterID, &roleID, &minutes)
	if err == pgx.ErrNoRows {
		return time.Time{}, ErrAccessRequestNotPending
	}
	if err != nil {
		return time.Time{}, err
	}
	expiresAt := now.UTC().Add(time.Duration(minutes) * time.Minute)

	// The role to come back to: the current permanent grant. A current
	// temporary grant restores what it would have restored.
	var restore *int
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(restore_role_id, role_id) FROM user_cluster_roles
		  WHERE user_id = $1 AND cluster_id = $2 FOR UPDATE`, userID, clusterID).Scan(&restore)
	if err != nil && err != pgx.ErrNoRows {
		return time.Time{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO user_cluster_roles (user_id, cluster_id, role_id, expires_at, restore_role_id, request_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (user_id, cluster_id) DO UPDATE
		   SET role_id = EXCLUDED.role_id, expires_at = EXCLUDED.expires_at,
		       restore_role_id = EXCLUDED.restore_role_id, request_id = EXCLUDED.request_id`,
		userID, clusterID, roleID, expiresAt, restore, id); err != nil {
		return time.Time{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE access_requests SET status = $5, decided_by = $2, decided_at = $3, decision_note = $4, expires_at = $6
		  WHERE id = $1`,
		id, deciderID, now.UTC(), nullIfEmpty(note), AccessRequestApproved, expiresAt); err != nil {
		return time.Time{}, err
	}
	// Tokens carry the old matrix: the next request signs the user back in.
	if _, err := tx.Exec(ctx,
		`UPDATE auth_users SET token_version = token_version + 1, updated_at = $1 WHERE id = $2`,
		now.UTC(), userID); err != nil {
		return time.Time{}, err
	}
	return expiresAt, tx.Commit(ctx)
}

// EndApprovedRequests closes the approved requests behind the user's grant on
// clusterID (an admin set or revoked the role by hand). Returns rows closed.
func (r *Repository) EndApprovedRequests(ctx context.Context, userID, clusterID, reason string, now time.Time) (int64, error) {
	tag, err := r.pool.Exec(ctx,
		`UPDATE access_requests SET status = $5, ended_at = $3, end_reason = $4
		  WHERE user_id = $1 AND cluster_id = $2 AND status = $6`,
		userID, clusterID, now.UTC(), reason, AccessRequestExpired, AccessRequestApproved)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ExpiredGrant describes one temporary grant the sweeper reverted.
type ExpiredGrant struct {
	UserID       string
	UserEmail    string
	ClusterID    string
	Role         string  // the role that expired
	RestoredRole *string // nil when the grant was removed
	RequestID    *string
}

// ExpireGrants reverts every temporary grant whose time has passed: the row
// goes back to restore_role_id (or is deleted), the request behind it is
// closed, and the user's tokens are revoked so the next request re-issues a
// token without the role. Rows another replica is already reverting are
// skipped (FOR UPDATE SKIP LOCKED).
func (r *Repository) ExpireGrants(ctx context.Context, now time.Time) ([]ExpiredGrant, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`SELECT ucr.user_id, u.email, ucr.cluster_id, ro.name, ucr.restore_role_id, rr.name, ucr.request_id
		   FROM user_cluster_roles ucr
		   JOIN auth_users u ON u.id = ucr.user_id
		   JOIN roles ro ON ro.id = ucr.role_id
		   LEFT JOIN roles rr ON rr.id = ucr.restore_role_id
		  WHERE ucr.expires_at IS NOT NULL AND ucr.expires_at <= $1
		  FOR UPDATE OF ucr SKIP LOCKED`, now.UTC())
	if err != nil {
		return nil, err
	}
	type pending struct {
		g         ExpiredGrant
		restoreID *int
	}
	var found []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.g.UserID, &p.g.UserEmail, &p.g.ClusterID, &p.g.Role, &p.restoreID, &p.g.RestoredRole, &p.g.RequestID); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, tx.Commit(ctx)
	}

	out := make([]ExpiredGrant, 0, len(found))
	for _, p := range found {
		if p.restoreID == nil {
			_, err = tx.Exec(ctx, `DELETE FROM user_cluster_roles WHERE user_id = $1 AND cluster_id = $2`, p.g.UserID, p.g.ClusterID)
		} else {
			_, err = tx.Exec(ctx,
				`UPDATE user_cluster_roles SET role_id = $3, expires_at = NULL, restore_role_id = NULL, request_id = NULL
				  WHERE user_id = $1 AND cluster_id = $2`, p.g.UserID, p.g.ClusterID, *p.restoreID)
		}
		if err != nil {
			return nil, err
		}
		if p.g.RequestID != nil {
			if _, err := tx.Exec(ctx,
				`UPDATE access_requests SET status = $3, ended_at = $2, end_reason = $4 WHERE id = $1 AND status = $5`,
				*p.g.RequestID, now.UTC(), AccessRequestExpired, EndReasonExpired, AccessRequestApproved); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE auth_users SET token_version = token_version + 1, updated_at = $1 WHERE id = $2`,
			now.UTC(), p.g.UserID); err != nil {
			return nil, err
		}
		out = append(out, p.g)
	}
	return out, tx.Commit(ctx)
}

// LapsedRequest is a pending request nobody reviewed within the request TTL.
type LapsedRequest struct {
	ID        string
	UserID    string
	UserEmail string
	ClusterID string
	Role      string
}

// ExpirePendingRequests closes pending requests created before `before`.
func (r *Repository) ExpirePendingRequests(ctx context.Context, before, now time.Time) ([]LapsedRequest, error) {
	rows, err := r.pool.Query(ctx,
		`WITH lapsed AS (
		   UPDATE access_requests SET status = $3, ended_at = $2, end_reason = $4
		    WHERE status = $5 AND created_at < $1
		   RETURNING id, user_id, cluster_id, role_id)
		 SELECT l.id, l.user_id, u.email, l.cluster_id, ro.name
		   FROM lapsed l JOIN auth_users u ON u.id = l.user_id JOIN roles ro ON ro.id = l.role_id`,
		before.UTC(), now.UTC(), AccessRequestExpired, EndReasonNotReviewed, AccessRequestPending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LapsedRequest
	for rows.Next() {
		var l LapsedRequest
		if err := rows.Scan(&l.ID, &l.UserID, &l.UserEmail, &l.ClusterID, &l.Role); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
