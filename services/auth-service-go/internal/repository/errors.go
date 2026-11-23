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

// IsRoleNameTaken reports whether err is Postgres SQLSTATE 23505 on a role's
// name: another role holds it as written (roles_name_key) or its name makes the
// same group (roles_name_group_key, migration 25).
func IsRoleNameTaken(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" &&
		(pgErr.ConstraintName == "roles_name_key" || pgErr.ConstraintName == "roles_name_group_key")
}
