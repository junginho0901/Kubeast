package repository

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// IsForeignKeyViolation reports whether err is Postgres SQLSTATE 23503 — the
// referenced row does not exist (for cluster grants: the cluster id is not
// registered).
func IsForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
