package auditchain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the database side of the chain (PG below; fakes in tests).
type Store interface {
	// SealBatch chains up to limit unsealed rows in one transaction and
	// returns how many it sealed and the new head. ErrBusy when another
	// replica holds the lock.
	SealBatch(ctx context.Context, limit int) (int, Head, error)
	Head(ctx context.Context) (Head, error)
	// Bounds returns the oldest and newest sealed positions (0 when none)
	// and how many rows are not sealed yet.
	Bounds(ctx context.Context) (oldest, newest, unsealed int64, err error)
	Rows(ctx context.Context, fromSeq, toSeq int64, limit int) ([]Row, error)
	LastAnchor(ctx context.Context) (*Anchor, error)
	AnchorsIn(ctx context.Context, fromSeq, toSeq int64) ([]Anchor, error)
	InsertAnchor(ctx context.Context, a Anchor) (int64, error)
	ReviewHashesBetween(ctx context.Context, since, until time.Time) ([]ReviewHash, error)
	ReviewHashes(ctx context.Context, ids []string) (map[string][]byte, error)
}

// lockKey is the advisory lock the sealing transaction takes (distinct from
// the sink dispatcher's).
const lockKey int64 = 7_432_119_027

// PG is the Store over the shared database.
type PG struct{ Pool *pgxpool.Pool }

func (p PG) SealBatch(ctx context.Context, limit int) (int, Head, error) {
	if limit <= 0 {
		limit = DefaultBatch
	}
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return 0, Head{}, err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, lockKey).Scan(&locked); err != nil {
		return 0, Head{}, err
	}
	if !locked {
		return 0, Head{}, ErrBusy
	}
	head, err := readHead(ctx, tx)
	if err != nil {
		return 0, Head{}, err
	}
	rows, err := tx.Query(ctx, `SELECT id, `+CanonSQL+` FROM auth_audit_logs WHERE chain_seq IS NULL ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return 0, head, err
	}
	var unsealed []Unsealed
	for rows.Next() {
		var u Unsealed
		if err := rows.Scan(&u.ID, &u.Canon); err != nil {
			rows.Close()
			return 0, head, err
		}
		unsealed = append(unsealed, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, head, err
	}
	if len(unsealed) == 0 {
		return 0, head, nil
	}
	sealed, newHead := sealRows(head, unsealed)
	ids := make([]int64, len(sealed))
	seqs := make([]int64, len(sealed))
	prevs := make([][]byte, len(sealed))
	hashes := make([][]byte, len(sealed))
	for i, s := range sealed {
		ids[i], seqs[i], prevs[i], hashes[i] = s.ID, s.Seq, s.Prev, s.Hash
	}
	tag, err := tx.Exec(ctx, `
		UPDATE auth_audit_logs AS a
		   SET chain_seq = v.seq, prev_hash = v.prev, row_hash = v.hash
		  FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS seq, unnest($3::bytea[]) AS prev, unnest($4::bytea[]) AS hash) AS v
		 WHERE a.id = v.id AND a.chain_seq IS NULL`, ids, seqs, prevs, hashes)
	if err != nil {
		return 0, head, err
	}
	if int(tag.RowsAffected()) != len(sealed) {
		return 0, head, fmt.Errorf("auditchain: sealed %d of %d rows (a row vanished during sealing)", tag.RowsAffected(), len(sealed))
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, head, err
	}
	return len(sealed), newHead, nil
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func readHead(ctx context.Context, q querier) (Head, error) {
	var h Head
	err := q.QueryRow(ctx, `SELECT chain_seq, row_hash FROM auth_audit_logs WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1`).Scan(&h.Seq, &h.Hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return Head{Seq: 0, Hash: Genesis}, nil
	}
	return h, err
}

func (p PG) Head(ctx context.Context) (Head, error) { return readHead(ctx, p.Pool) }

func (p PG) Bounds(ctx context.Context) (oldest, newest, unsealed int64, err error) {
	err = p.Pool.QueryRow(ctx, `
		SELECT COALESCE(MIN(chain_seq), 0), COALESCE(MAX(chain_seq), 0),
		       (SELECT COUNT(*) FROM auth_audit_logs WHERE chain_seq IS NULL)
		  FROM auth_audit_logs WHERE chain_seq IS NOT NULL`).Scan(&oldest, &newest, &unsealed)
	return
}

func (p PG) Rows(ctx context.Context, fromSeq, toSeq int64, limit int) ([]Row, error) {
	rows, err := p.Pool.Query(ctx, `SELECT chain_seq, id, prev_hash, row_hash, `+CanonSQL+`
		  FROM auth_audit_logs WHERE chain_seq BETWEEN $1 AND $2 ORDER BY chain_seq LIMIT $3`, fromSeq, toSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.Seq, &r.ID, &r.Prev, &r.Hash, &r.Canon); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

const anchorColumns = `id, created_at, from_seq, to_seq, row_count, head_hash, prev_anchor_hash, anchor_hash, sink, object_key, actor`

func scanAnchor(row pgx.Row) (Anchor, error) {
	var a Anchor
	err := row.Scan(&a.ID, &a.CreatedAt, &a.FromSeq, &a.ToSeq, &a.Rows, &a.HeadHash, &a.PrevAnchorHash, &a.AnchorHash, &a.Sink, &a.ObjectKey, &a.Actor)
	return a, err
}

func (p PG) LastAnchor(ctx context.Context) (*Anchor, error) {
	a, err := scanAnchor(p.Pool.QueryRow(ctx, `SELECT `+anchorColumns+` FROM audit_anchors ORDER BY id DESC LIMIT 1`))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (p PG) AnchorsIn(ctx context.Context, fromSeq, toSeq int64) ([]Anchor, error) {
	rows, err := p.Pool.Query(ctx, `SELECT `+anchorColumns+` FROM audit_anchors WHERE to_seq BETWEEN $1 AND $2 ORDER BY id`, fromSeq, toSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Anchor{}
	for rows.Next() {
		a, err := scanAnchor(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (p PG) InsertAnchor(ctx context.Context, a Anchor) (int64, error) {
	var id int64
	err := p.Pool.QueryRow(ctx, `INSERT INTO audit_anchors (created_at, from_seq, to_seq, row_count, head_hash, prev_anchor_hash, anchor_hash, sink, object_key, actor)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
		a.CreatedAt.UTC(), a.FromSeq, a.ToSeq, a.Rows, a.HeadHash, a.PrevAnchorHash, a.AnchorHash, a.Sink, a.ObjectKey, a.Actor).Scan(&id)
	return id, err
}

// ReviewHashesBetween hashes the access review sign-offs made in (since, until].
func (p PG) ReviewHashesBetween(ctx context.Context, since, until time.Time) ([]ReviewHash, error) {
	if since.IsZero() {
		since = time.Unix(0, 0)
	}
	rows, err := p.Pool.Query(ctx, `SELECT id, reviewed_at, sha256(convert_to(snapshot::text, 'UTF8')) FROM access_reviews
		 WHERE reviewed_at > $1 AND reviewed_at <= $2 ORDER BY reviewed_at, id`, since.UTC(), until.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewHash{}
	for rows.Next() {
		var r ReviewHash
		if err := rows.Scan(&r.ID, &r.ReviewedAt, &r.Hash); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p PG) ReviewHashes(ctx context.Context, ids []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `SELECT id, sha256(convert_to(snapshot::text, 'UTF8')) FROM access_reviews WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var h []byte
		if err := rows.Scan(&id, &h); err != nil {
			return nil, err
		}
		out[id] = h
	}
	return out, rows.Err()
}
