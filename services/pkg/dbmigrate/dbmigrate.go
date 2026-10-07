// Package dbmigrate owns the Kubeast database schema: versioned SQL
// migrations embedded in the binary and applied with goose. auth-service is
// the single writer (Up); every other service only checks that the database
// is at least at the version its code needs (WaitFor) and refuses to start
// otherwise, instead of running its own DDL.
package dbmigrate

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Required is the schema version this build of the services needs. Bump it
// together with every new migration file under migrations/.
const Required int64 = 8

const (
	dir          = "migrations"
	versionTable = "goose_db_version"
	pollInterval = 2 * time.Second
)

// ErrBehind is returned by WaitFor when the database stays below the required
// version until the timeout.
var ErrBehind = errors.New("dbmigrate: database schema is behind this build")

// Up applies every pending migration through the pool and returns the
// resulting schema version. Concurrent callers serialize on a Postgres
// session lock, so two replicas starting at once do not race.
func Up(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return UpDB(ctx, stdlib.OpenDBFromPool(pool))
}

// UpDB is Up for a database/sql handle.
func UpDB(ctx context.Context, db *sql.DB) (int64, error) {
	p, err := newProvider(db)
	if err != nil {
		return 0, err
	}
	results, err := p.Up(ctx)
	if err != nil {
		return 0, fmt.Errorf("dbmigrate: up: %w", err)
	}
	for _, r := range results {
		slog.Info("dbmigrate: applied", "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	v, err := p.GetDBVersion(ctx)
	if err != nil {
		return 0, fmt.Errorf("dbmigrate: version after up: %w", err)
	}
	return v, nil
}

func newProvider(db *sql.DB) (*goose.Provider, error) {
	fsys, err := fs.Sub(migrations, dir)
	if err != nil {
		return nil, fmt.Errorf("dbmigrate: migrations fs: %w", err)
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, fmt.Errorf("dbmigrate: session locker: %w", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, db, fsys, goose.WithSessionLocker(locker))
	if err != nil {
		return nil, fmt.Errorf("dbmigrate: provider: %w", err)
	}
	return p, nil
}

// Version reports the applied schema version without touching the schema:
// 0 when the version table does not exist yet.
func Version(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return VersionDB(ctx, stdlib.OpenDBFromPool(pool))
}

// VersionDB is Version for a database/sql handle.
func VersionDB(ctx context.Context, db *sql.DB) (int64, error) {
	var exists bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`, versionTable,
	).Scan(&exists); err != nil {
		return 0, fmt.Errorf("dbmigrate: version table lookup: %w", err)
	}
	if !exists {
		return 0, nil
	}
	var v sql.NullInt64
	err := db.QueryRowContext(ctx,
		`SELECT version_id FROM `+versionTable+` WHERE is_applied ORDER BY id DESC LIMIT 1`,
	).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("dbmigrate: read version: %w", err)
	}
	return v.Int64, nil
}

// WaitFor blocks until the database reports at least the required version,
// polling every two seconds, and returns ErrBehind (wrapped with the versions)
// when the timeout passes first. Services that do not own the schema call this
// at start-up so a rollout never runs new code against an old schema.
func WaitFor(ctx context.Context, pool *pgxpool.Pool, required int64, timeout time.Duration) error {
	return WaitForDB(ctx, stdlib.OpenDBFromPool(pool), required, timeout)
}

// WaitForDB is WaitFor for a database/sql handle.
func WaitForDB(ctx context.Context, db *sql.DB, required int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		v, err := VersionDB(ctx, db)
		if err == nil && v >= required {
			return nil
		}
		if time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("%w: version check failed: %v", ErrBehind, err)
			}
			return fmt.Errorf("%w: version %d required, database is at %d — run the auth-service migrations first", ErrBehind, required, v)
		}
		slog.Info("dbmigrate: waiting for schema", "required", required, "current", v, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}
