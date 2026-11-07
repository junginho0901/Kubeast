// Package sessioncheck reads the current token version for connections that stay open past their token.
package sessioncheck

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// querier is the part of a pool the lookup uses.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Lookup reads what auth-service's token-version answer reads, from the database the services share. That answer takes
// a live token as its credential, and an open connection's token has usually expired by the time it asks.
func Lookup(db querier) auth.VersionLookup {
	return func(ctx context.Context, userID, apiKeyID string) (int, error) {
		if apiKeyID != "" {
			var expires time.Time
			err := db.QueryRow(ctx, `SELECT expires_at FROM api_keys WHERE id = $1 AND user_id = $2`, apiKeyID, userID).Scan(&expires)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expires.After(time.Now())) {
				return 0, auth.ErrSubjectGone
			}
			if err != nil {
				return 0, err
			}
		}
		var version int
		err := db.QueryRow(ctx, `SELECT token_version FROM auth_users WHERE id = $1`, userID).Scan(&version)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, auth.ErrSubjectGone
		}
		return version, err
	}
}
