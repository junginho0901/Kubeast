package drains

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PG is node_drains in the shared database. Heartbeats and staleness are
// compared with the database's clock (NOW()), so replicas' clocks do not matter.
type PG struct{ Pool *pgxpool.Pool }

const rowColumns = `id, cluster, node, COALESCE(user_id, ''), COALESCE(user_email, ''), status, COALESCE(message, ''),
	pods_total, pods_done, owner, audit, started_at, updated_at, finished_at`

func scanRow(row pgx.Row, extra ...any) (Row, error) {
	var r Row
	dest := append([]any{&r.ID, &r.Cluster, &r.Node, &r.UserID, &r.UserEmail, &r.Status, &r.Message,
		&r.PodsTotal, &r.PodsDone, &r.Owner, &r.Audit, &r.StartedAt, &r.UpdatedAt, &r.FinishedAt}, extra...)
	err := row.Scan(dest...)
	return r, err
}

func collect(rows pgx.Rows, err error) ([]Row, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p PG) Insert(ctx context.Context, r Row) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO node_drains (id, cluster, node, user_id, user_email, status, owner, audit, heartbeat_at, started_at, updated_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7, $8, NOW(), NOW(), NOW())`,
		r.ID, r.Cluster, r.Node, r.UserID, r.UserEmail, r.Status, r.Owner, []byte(r.Audit))
	return err
}

func (p PG) Progress(ctx context.Context, id, owner string, pr Progress) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE node_drains SET status = COALESCE(NULLIF($3, ''), status), message = COALESCE($4::text, message),
			pods_total = COALESCE($5::int, pods_total), pods_done = COALESCE($6::int, pods_done), updated_at = NOW()
		WHERE id = $1 AND owner = $2 AND finished_at IS NULL`,
		id, owner, pr.Status, pr.Message, pr.PodsTotal, pr.PodsDone)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (p PG) Finish(ctx context.Context, id, owner, status, message string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `
		UPDATE node_drains SET status = $3, message = NULLIF($4, ''), finished_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND owner = $2 AND finished_at IS NULL`, id, owner, status, message)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (p PG) Get(ctx context.Context, id string, staleAfter time.Duration) (*Row, error) {
	var stale bool
	r, err := scanRow(p.Pool.QueryRow(ctx, `
		SELECT `+rowColumns+`, (finished_at IS NULL AND heartbeat_at < NOW() - make_interval(secs => $2::double precision))
		FROM node_drains WHERE id = $1`, id, staleAfter.Seconds()), &stale)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Stale = stale
	return &r, nil
}

func (p PG) Beat(ctx context.Context, owner string) ([]string, error) {
	rows, err := p.Pool.Query(ctx, `UPDATE node_drains SET heartbeat_at = NOW() WHERE owner = $1 AND finished_at IS NULL RETURNING id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// Interrupt is one UPDATE whose condition PostgreSQL checks again on the row
// it locks: of two at once the second finds the row finished, and an owner's
// beat that came first leaves it fresh.
func (p PG) Interrupt(ctx context.Context, id string, staleAfter time.Duration, message string) ([]Row, error) {
	return collect(p.Pool.Query(ctx, `
		UPDATE node_drains SET status = 'interrupted', message = $3, finished_at = NOW(), updated_at = NOW()
		WHERE finished_at IS NULL AND heartbeat_at < NOW() - make_interval(secs => $2::double precision) AND ($1 = '' OR id = $1)
		RETURNING `+rowColumns, id, staleAfter.Seconds(), message))
}

func (p PG) HandOver(ctx context.Context, owner, message string) ([]Row, error) {
	return collect(p.Pool.Query(ctx, `
		UPDATE node_drains SET status = 'interrupted', message = $2, finished_at = NOW(), updated_at = NOW()
		WHERE owner = $1 AND finished_at IS NULL
		RETURNING `+rowColumns, owner, message))
}

func (p PG) Purge(ctx context.Context, keep time.Duration, batch int) (int64, error) {
	tag, err := p.Pool.Exec(ctx, `
		DELETE FROM node_drains WHERE id IN (
			SELECT id FROM node_drains WHERE finished_at < NOW() - make_interval(secs => $1::double precision) ORDER BY finished_at LIMIT $2)`,
		keep.Seconds(), batch)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (p PG) Ping(ctx context.Context) error { return p.Pool.Ping(ctx) }
