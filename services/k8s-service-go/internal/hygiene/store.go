// Package hygiene stores cluster hygiene sign-offs (table hygiene_reviews):
// who signed a cluster's report, when, with a note and the report as it stood.
// auth-service deletes them after RETENTION_REVIEW_DAYS.
package hygiene

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("hygiene review not found")

type Review struct {
	ID              string          `json:"id"`
	Cluster         string          `json:"cluster"`
	ReviewedBy      *string         `json:"reviewed_by,omitempty"`
	ReviewedByEmail string          `json:"reviewed_by_email"`
	ReviewedAt      time.Time       `json:"reviewed_at"`
	Note            string          `json:"note"`
	Counts          json.RawMessage `json:"counts"`
	Snapshot        json.RawMessage `json:"snapshot,omitempty"`
}

type Store interface {
	Create(ctx context.Context, r *Review) error
	// List returns a cluster's sign-offs, newest first, without snapshots.
	List(ctx context.Context, cluster string, limit int) ([]Review, error)
	Get(ctx context.Context, cluster, id string) (*Review, error)
}

func NewStore(pool *pgxpool.Pool) Store { return &pgStore{pool: pool} }

type pgStore struct{ pool *pgxpool.Pool }

func (s *pgStore) Create(ctx context.Context, r *Review) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO hygiene_reviews (id, cluster, reviewed_by, reviewed_by_email, reviewed_at, note, counts, snapshot)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		r.ID, r.Cluster, r.ReviewedBy, r.ReviewedByEmail, r.ReviewedAt, r.Note, r.Counts, r.Snapshot)
	return err
}

func (s *pgStore) List(ctx context.Context, cluster string, limit int) ([]Review, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, cluster, reviewed_by, reviewed_by_email, reviewed_at, note, counts
		   FROM hygiene_reviews WHERE cluster = $1 ORDER BY reviewed_at DESC LIMIT $2`, cluster, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Review{}
	for rows.Next() {
		var r Review
		if err := rows.Scan(&r.ID, &r.Cluster, &r.ReviewedBy, &r.ReviewedByEmail, &r.ReviewedAt, &r.Note, &r.Counts); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *pgStore) Get(ctx context.Context, cluster, id string) (*Review, error) {
	var r Review
	err := s.pool.QueryRow(ctx,
		`SELECT id, cluster, reviewed_by, reviewed_by_email, reviewed_at, note, counts, snapshot
		   FROM hygiene_reviews WHERE id = $1 AND cluster = $2`, id, cluster).
		Scan(&r.ID, &r.Cluster, &r.ReviewedBy, &r.ReviewedByEmail, &r.ReviewedAt, &r.Note, &r.Counts, &r.Snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}
