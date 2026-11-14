package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func (r *Repository) CreateUser(ctx context.Context, u *model.User) error {
	if u.AuthSource == "" {
		u.AuthSource = model.AuthSourcePassword
	}
	_, err := r.pool.Exec(ctx,
		`INSERT INTO auth_users (id, name, email, team, role_id, password_hash, auth_source, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		u.ID, u.Name, u.Email, u.Team, u.RoleID, u.PasswordHash, u.AuthSource, u.CreatedAt, u.UpdatedAt,
	)
	return err
}

func (r *Repository) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.token_version, u.auth_source, u.created_at, u.updated_at,
		        u.failed_logins, u.last_failed_login, u.locked_until, u.last_login_at, u.dormant_locked_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.email = $1`, email,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.TokenVersion, &u.AuthSource, &u.CreatedAt, &u.UpdatedAt,
		&u.FailedLogins, &u.LastFailedLogin, &u.LockedUntil, &u.LastLoginAt, &u.DormantLockedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

func (r *Repository) GetUserByID(ctx context.Context, id string) (*model.User, error) {
	var u model.User
	err := r.pool.QueryRow(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.token_version, u.auth_source, u.created_at, u.updated_at,
		        u.last_login_at, u.locked_until, u.dormant_locked_at
		 FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, id,
	).Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.TokenVersion, &u.AuthSource, &u.CreatedAt, &u.UpdatedAt,
		&u.LastLoginAt, &u.LockedUntil, &u.DormantLockedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

// GetTokenVersion returns the user's current token_version; an error (including
// pgx.ErrNoRows for a deleted user) means no token is acceptable.
func (r *Repository) GetTokenVersion(ctx context.Context, id string) (int, error) {
	var v int
	err := r.pool.QueryRow(ctx, `SELECT token_version FROM auth_users WHERE id = $1`, id).Scan(&v)
	return v, err
}

// SessionStateFor is what a presented token is checked against: the user's
// token_version and signed-out sign-ins in one statement
// (auth.SessionStateQuery). A token an API key was exchanged for (apiKeyID
// set) is revoked with the key, so a key deleted or past its expiry answers
// ErrAPIKeyNotFound and the token stops working on the validators' next check
// instead of at its own expiry.
func (r *Repository) SessionStateFor(ctx context.Context, userID, apiKeyID string) (auth.SessionState, error) {
	if apiKeyID != "" {
		var expires time.Time
		err := r.pool.QueryRow(ctx, `SELECT expires_at FROM api_keys WHERE id = $1 AND user_id = $2`, apiKeyID, userID).Scan(&expires)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expires.After(time.Now())) {
			return auth.SessionState{}, ErrAPIKeyNotFound
		}
		if err != nil {
			return auth.SessionState{}, err
		}
	}
	var state auth.SessionState
	err := r.pool.QueryRow(ctx, auth.SessionStateQuery, userID).Scan(&state.Version, &state.SignedOut)
	return state, err
}

// EndSignIn records that the user's sign-in at authTime (the auth_time its
// tokens carry) was signed out. Signing out again is no change, and a user
// who is gone has nothing to end: every token of theirs is refused already.
func (r *Repository) EndSignIn(ctx context.Context, userID string, authTime int64) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO ended_sign_ins (user_id, auth_time) VALUES ($1, $2) ON CONFLICT (user_id, auth_time) DO NOTHING`,
		userID, authTime,
	)
	if IsForeignKeyViolation(err) {
		return nil
	}
	return err
}

// DeleteEndedSignIns deletes up to batch signed-out sign-ins that ended more
// than keep ago, by the database's clock as ended_at was written, and says how
// many it deleted.
func (r *Repository) DeleteEndedSignIns(ctx context.Context, keep time.Duration, batch int) (int64, error) {
	tag, err := r.pool.Exec(ctx,
		`DELETE FROM ended_sign_ins WHERE (user_id, auth_time) IN (
		   SELECT user_id, auth_time FROM ended_sign_ins WHERE ended_at < NOW() - make_interval(secs => $1) ORDER BY ended_at LIMIT $2)`,
		keep.Seconds(), batch,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// BumpTokenVersion invalidates every token issued to the user so far.
func (r *Repository) BumpTokenVersion(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET token_version = token_version + 1, updated_at = $1 WHERE id = $2`,
		time.Now().UTC(), id,
	)
	return err
}

// SaveLoginFailure stores the lockout state after a password failure
// (handler.lockoutState decides it). lockedUntil nil = not locked.
func (r *Repository) SaveLoginFailure(ctx context.Context, id string, failures int, lastFailure time.Time, lockedUntil *time.Time) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET failed_logins = $1, last_failed_login = $2, locked_until = $3 WHERE id = $4`,
		failures, lastFailure.UTC(), lockedUntil, id,
	)
	return err
}

// ResetLoginFailures clears the lockout state after a successful login.
func (r *Repository) ResetLoginFailures(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET failed_logins = 0, last_failed_login = NULL, locked_until = NULL WHERE id = $1`, id,
	)
	return err
}

func (r *Repository) ListUsers(ctx context.Context, limit, offset int) ([]model.User, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT u.id, u.name, u.email, u.team, u.role_id, r.name, u.password_hash, u.auth_source, u.created_at, u.updated_at,
		        u.last_login_at, u.locked_until, u.dormant_locked_at
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
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Team, &u.RoleID, &u.RoleName, &u.PasswordHash, &u.AuthSource, &u.CreatedAt, &u.UpdatedAt,
			&u.LastLoginAt, &u.LockedUntil, &u.DormantLockedAt); err != nil {
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

// UpdateUserRoleEndingTokens changes the role and ends the tokens issued so far, which carry the old role, in one
// statement: the change never stands while those tokens still work.
func (r *Repository) UpdateUserRoleEndingTokens(ctx context.Context, id string, roleID int) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET role_id = $1, token_version = token_version + 1, updated_at = $2 WHERE id = $3`,
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

// UpdateUserPasswordEndingTokens sets the password and ends the tokens issued so far in one statement: a password
// changed to shut someone out never stands while their token still works.
func (r *Repository) UpdateUserPasswordEndingTokens(ctx context.Context, id, passwordHash string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE auth_users SET password_hash = $1, token_version = token_version + 1, updated_at = $2 WHERE id = $3`,
		passwordHash, time.Now().UTC(), id,
	)
	return err
}

func (r *Repository) DeleteUser(ctx context.Context, id string) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM auth_users WHERE id = $1`, id)
	return err
}
