package recording

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// openRow is a recording whose row is still recording or uploading, as
// recovery reads it.
type openRow struct {
	id, kind, cluster, target, location, status string
	uploaded                                    int64
	parts                                       int
	startedAt                                   time.Time
}

// index is the recorder's writes to session_recordings: pgIndex, or a
// stand-in in tests that run without PostgreSQL.
type index interface {
	insert(ctx context.Context, meta Meta, storage, location string) error
	remove(ctx context.Context, id string) error
	ended(ctx context.Context, id string, size int64, truncated bool) error
	uploaded(ctx context.Context, id string, offset int64, parts int, ended bool) error
	failed(ctx context.Context, id, reason string) error
	finished(ctx context.Context, id, status string) error
	open(ctx context.Context) ([]openRow, error)
	lost(ctx context.Context, id string) error
	cutOff(ctx context.Context, id string, size int64) error
}

type pgIndex struct{ pool *pgxpool.Pool }

func (x pgIndex) insert(ctx context.Context, meta Meta, storage, location string) error {
	_, err := x.pool.Exec(ctx, `
		INSERT INTO session_recordings (id, kind, user_id, user_email, cluster, namespace, target, container, storage, location, started_at, status)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, NULLIF($6,''), $7, NULLIF($8,''), $9, $10, $11, 'recording')`,
		meta.ID, meta.Kind, meta.UserID, meta.UserEmail, meta.Cluster, meta.Namespace, meta.Target, meta.Container, storage, location, meta.StartedAt)
	return err
}

func (x pgIndex) remove(ctx context.Context, id string) error {
	_, err := x.pool.Exec(ctx, `DELETE FROM session_recordings WHERE id = $1`, id)
	return err
}

func (x pgIndex) ended(ctx context.Context, id string, size int64, truncated bool) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET ended_at = NOW(), bytes = $2, truncated = $3, status = 'uploading', updated_at = NOW() WHERE id = $1`, id, size, truncated)
	return err
}

func (x pgIndex) uploaded(ctx context.Context, id string, offset int64, parts int, ended bool) error {
	status := "recording"
	if ended {
		status = "uploading"
	}
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET uploaded_bytes = $2, parts = $3, status = CASE WHEN status = 'recording' THEN $4 ELSE status END, last_error = NULL, updated_at = NOW() WHERE id = $1`,
		id, offset, parts, status)
	return err
}

func (x pgIndex) failed(ctx context.Context, id, reason string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET last_error = $2, updated_at = NOW() WHERE id = $1`, id, reason)
	return err
}

func (x pgIndex) finished(ctx context.Context, id, status string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET status = $2, last_error = NULL, updated_at = NOW() WHERE id = $1`, id, status)
	return err
}

func (x pgIndex) open(ctx context.Context) ([]openRow, error) {
	rows, err := x.pool.Query(ctx, `SELECT id, kind, cluster, target, location, uploaded_bytes, parts, status, started_at FROM session_recordings WHERE status IN ('recording', 'uploading')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []openRow
	for rows.Next() {
		var r openRow
		if err := rows.Scan(&r.id, &r.kind, &r.cluster, &r.target, &r.location, &r.uploaded, &r.parts, &r.status, &r.startedAt); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return list, rows.Err()
}

func (x pgIndex) lost(ctx context.Context, id string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW()), bytes = GREATEST(bytes, uploaded_bytes), last_error = 'spool file lost; parts uploaded before are kept', updated_at = NOW() WHERE id = $1`, id)
	return err
}

func (x pgIndex) cutOff(ctx context.Context, id string, size int64) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET ended_at = COALESCE(ended_at, NOW()), bytes = $2, updated_at = NOW() WHERE id = $1`, id, size)
	return err
}
