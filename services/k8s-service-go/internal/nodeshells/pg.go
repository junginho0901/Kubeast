package nodeshells

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PG is node_shells in the shared database. Heartbeats and staleness are
// compared with the database's clock (NOW()), so replicas' clocks do not matter.
type PG struct{ Pool *pgxpool.Pool }

func (p PG) Insert(ctx context.Context, r Row) error {
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO node_shells (id, cluster, namespace, pod, node, owner, person, audit, heartbeat_at, opened_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
		r.ID, r.Cluster, r.Namespace, r.Pod, r.Node, r.Owner, []byte(r.Person), []byte(r.Audit))
	return err
}

func (p PG) Beat(ctx context.Context, owner string, ids []string) ([]string, error) {
	rows, err := p.Pool.Query(ctx, `UPDATE node_shells SET heartbeat_at = NOW() WHERE owner = $1 AND id = ANY($2::text[]) RETURNING id`, owner, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		found = append(found, id)
	}
	return found, rows.Err()
}

// Take is one UPDATE whose condition PostgreSQL checks again on each row it
// locks: of two sweeps at once the second skips the rows the first holds, and
// an owner's beat that came first leaves its row fresh. It returns each row
// with the owner it had before.
func (p PG) Take(ctx context.Context, owner string, staleAfter time.Duration, skip []string, limit int) ([]Row, error) {
	if skip == nil {
		skip = []string{}
	}
	rows, err := p.Pool.Query(ctx, `
		UPDATE node_shells n SET owner = $1, heartbeat_at = NOW()
		FROM (
			SELECT id, owner FROM node_shells
			WHERE heartbeat_at < NOW() - make_interval(secs => $2::double precision) AND NOT (id = ANY($3::text[]))
			ORDER BY heartbeat_at LIMIT $4
			FOR UPDATE SKIP LOCKED) old
		WHERE n.id = old.id AND n.heartbeat_at < NOW() - make_interval(secs => $2::double precision)
		RETURNING n.id, n.cluster, n.namespace, n.pod, n.node, old.owner, n.person, n.audit, n.opened_at`,
		owner, staleAfter.Seconds(), skip, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var person, aud []byte
		if err := rows.Scan(&r.ID, &r.Cluster, &r.Namespace, &r.Pod, &r.Node, &r.Owner, &person, &aud, &r.OpenedAt); err != nil {
			return nil, err
		}
		r.Person, r.Audit = person, aud
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p PG) Remove(ctx context.Context, id, owner string) error {
	_, err := p.Pool.Exec(ctx, `DELETE FROM node_shells WHERE id = $1 AND owner = $2`, id, owner)
	return err
}

func (p PG) Ping(ctx context.Context) error { return p.Pool.Ping(ctx) }
