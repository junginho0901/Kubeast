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
	owner                                       string     // "" for a row written before rows had owners
	heartbeat                                   *time.Time // nil once its owner handed it over
}

// index is the recorder's writes to session_recordings: pgIndex, or a
// stand-in in tests that run without PostgreSQL.
type index interface {
	insert(ctx context.Context, meta Meta, storage, location, owner string) error
	remove(ctx context.Context, id string) error
	ended(ctx context.Context, id string, size int64, truncated bool) error
	uploaded(ctx context.Context, id string, offset int64, parts int, ended bool) error
	failed(ctx context.Context, id, reason string) error
	finished(ctx context.Context, id, status string) error
	// beat refreshes the heartbeat of the open rows owner holds.
	beat(ctx context.Context, owner string) error
	// open lists the open rows with the database's clock, which heartbeats are
	// written in.
	open(ctx context.Context) ([]openRow, time.Time, error)
	// take makes owner the row's owner if its owner and heartbeat are still
	// those r read; false when another process changed them first.
	take(ctx context.Context, r openRow, owner string) (bool, error)
	lost(ctx context.Context, id, owner string) error
	cutOff(ctx context.Context, id string, size int64) error
	// handOver clears the heartbeat of the open rows owner holds.
	handOver(ctx context.Context, owner string) error
}

type pgIndex struct{ pool *pgxpool.Pool }

func (x pgIndex) insert(ctx context.Context, meta Meta, storage, location, owner string) error {
	_, err := x.pool.Exec(ctx, `
		INSERT INTO session_recordings (id, kind, user_id, user_email, cluster, namespace, target, container, storage, location, started_at, status, owner, heartbeat_at)
		VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''), $5, NULLIF($6,''), $7, NULLIF($8,''), $9, $10, $11, 'recording', $12, NOW())`,
		meta.ID, meta.Kind, meta.UserID, meta.UserEmail, meta.Cluster, meta.Namespace, meta.Target, meta.Container, storage, location, meta.StartedAt, owner)
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

func (x pgIndex) beat(ctx context.Context, owner string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET heartbeat_at = NOW() WHERE owner = $1 AND status IN ('recording', 'uploading')`, owner)
	return err
}

// The columns are TIMESTAMP, written with NOW() in the session's time zone, so
// the clock they are read against is LOCALTIMESTAMP, not NOW().
func (x pgIndex) open(ctx context.Context) ([]openRow, time.Time, error) {
	rows, err := x.pool.Query(ctx, `
		SELECT id, kind, cluster, target, location, uploaded_bytes, parts, status, started_at, COALESCE(owner, ''), heartbeat_at, LOCALTIMESTAMP
		FROM session_recordings WHERE status IN ('recording', 'uploading')`)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer rows.Close()
	var list []openRow
	var now time.Time
	for rows.Next() {
		var r openRow
		if err := rows.Scan(&r.id, &r.kind, &r.cluster, &r.target, &r.location, &r.uploaded, &r.parts, &r.status, &r.startedAt, &r.owner, &r.heartbeat, &now); err != nil {
			return nil, time.Time{}, err
		}
		list = append(list, r)
	}
	return list, now, rows.Err()
}

func (x pgIndex) take(ctx context.Context, r openRow, owner string) (bool, error) {
	var prev *string
	if r.owner != "" {
		prev = &r.owner
	}
	tag, err := x.pool.Exec(ctx, `
		UPDATE session_recordings SET owner = $2, heartbeat_at = NOW()
		WHERE id = $1 AND status IN ('recording', 'uploading') AND owner IS NOT DISTINCT FROM $3::varchar AND heartbeat_at IS NOT DISTINCT FROM $4::timestamp`,
		r.id, owner, prev, r.heartbeat)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (x pgIndex) lost(ctx context.Context, id, owner string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW()), bytes = GREATEST(bytes, uploaded_bytes), last_error = 'spool file lost; parts uploaded before are kept', updated_at = NOW() WHERE id = $1 AND owner = $2`, id, owner)
	return err
}

func (x pgIndex) cutOff(ctx context.Context, id string, size int64) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET ended_at = COALESCE(ended_at, NOW()), bytes = $2, updated_at = NOW() WHERE id = $1`, id, size)
	return err
}

func (x pgIndex) handOver(ctx context.Context, owner string) error {
	_, err := x.pool.Exec(ctx, `UPDATE session_recordings SET heartbeat_at = NULL WHERE owner = $1 AND status IN ('recording', 'uploading')`, owner)
	return err
}
