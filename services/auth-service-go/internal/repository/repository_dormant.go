package repository

import (
	"context"
	"time"
)

// Dormant accounts: an account whose last activity (sign-in, API key use, or
// creation when neither happened) is older than the cutoff gets
// dormant_locked_at set and its tokens revoked; an admin unlocks it.

// DormantLocked is one account the sweeper locked.
type DormantLocked struct {
	UserID       string
	Email        string
	LastActivity time.Time
}

// LockDormantAccounts locks every unlocked account whose last activity is
// before cutoff. With exemptAdmins, accounts whose global role carries "*" or
// any admin.* permission are left alone (the last admin must stay able to
// sign in). Concurrent sweepers skip each other's rows.
func (r *Repository) LockDormantAccounts(ctx context.Context, cutoff, now time.Time, exemptAdmins bool) ([]DormantLocked, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`SELECT u.id, u.email,
		        GREATEST(COALESCE(u.last_login_at, u.created_at),
		                 COALESCE((SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.user_id = u.id), u.created_at)) AS last_activity
		   FROM auth_users u
		  WHERE u.dormant_locked_at IS NULL
		    AND GREATEST(COALESCE(u.last_login_at, u.created_at),
		                 COALESCE((SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.user_id = u.id), u.created_at)) < $1
		    AND ($2 = false OR NOT EXISTS (
		          SELECT 1 FROM role_permissions rp
		           WHERE rp.role_id = u.role_id AND (rp.permission = '*' OR rp.permission LIKE 'admin.%')))
		  ORDER BY u.email
		  FOR UPDATE OF u SKIP LOCKED`, cutoff.UTC(), exemptAdmins)
	if err != nil {
		return nil, err
	}
	var found []DormantLocked
	for rows.Next() {
		var d DormantLocked
		if err := rows.Scan(&d.UserID, &d.Email, &d.LastActivity); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, tx.Commit(ctx)
	}
	ids := make([]string, len(found))
	for i, d := range found {
		ids[i] = d.UserID
	}
	// token_version + 1 revokes the sessions the account still holds.
	if _, err := tx.Exec(ctx,
		`UPDATE auth_users SET dormant_locked_at = $1, token_version = token_version + 1 WHERE id = ANY($2)`,
		now.UTC(), ids); err != nil {
		return nil, err
	}
	return found, tx.Commit(ctx)
}

// UnlockUser clears the dormant lock and the password lock. Returns false
// when there is no such user.
func (r *Repository) UnlockUser(ctx context.Context, id string) (bool, error) {
	tag, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET dormant_locked_at = NULL, locked_until = NULL, failed_logins = 0, last_failed_login = NULL WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
