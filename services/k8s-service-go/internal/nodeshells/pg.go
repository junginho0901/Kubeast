package nodeshells

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PG is node_shells in the shared database. Heartbeats, staleness and expiry
// are compared with the database's clock (NOW()), so replicas' clocks do not
// matter.
//
// While this process holds a shell, its inserts and heartbeats go over one
// connection taken from the pool and kept (held): requests that fill the pool
// cannot hold the heartbeat back. It goes back to the pool once the process
// holds no shell (Idle), and one that failed is closed and taken again.
type PG struct {
	Pool *pgxpool.Pool

	mu   sync.Mutex
	held *pgxpool.Conn
}

// NewPG is node_shells over pool.
func NewPG(pool *pgxpool.Pool) *PG { return &PG{Pool: pool} }

// onHeld runs fn on the held connection, taking one from the pool first when
// none is held; a failure closes it so the next call takes a fresh one.
func (p *PG) onHeld(ctx context.Context, fn func(c *pgxpool.Conn) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held == nil {
		c, err := p.Pool.Acquire(ctx)
		if err != nil {
			return err
		}
		p.held = c
	}
	if err := fn(p.held); err != nil {
		_ = p.held.Conn().Close(context.Background())
		p.held.Release()
		p.held = nil
		return err
	}
	return nil
}

// Idle gives the held connection back to the pool.
func (p *PG) Idle() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held != nil {
		p.held.Release()
		p.held = nil
	}
}

func (p *PG) Insert(ctx context.Context, r Row) error {
	return p.onHeld(ctx, func(c *pgxpool.Conn) error {
		_, err := c.Exec(ctx, `
			INSERT INTO node_shells (id, cluster, namespace, pod, node, owner, person, audit, heartbeat_at, opened_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
			r.ID, r.Cluster, r.Namespace, r.Pod, r.Node, r.Owner, []byte(r.Person), []byte(r.Audit))
		return err
	})
}

func (p *PG) Beat(ctx context.Context, owner string, ids []string) ([]string, error) {
	var found []string
	err := p.onHeld(ctx, func(c *pgxpool.Conn) error {
		found = nil
		rows, err := c.Query(ctx, `UPDATE node_shells SET heartbeat_at = NOW() WHERE owner = $1 AND id = ANY($2::text[]) AND released_at IS NULL RETURNING id`, owner, ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			found = append(found, id)
		}
		return rows.Err()
	})
	return found, err
}

// Take is one UPDATE whose condition PostgreSQL checks again on each row it
// locks: of two sweeps at once the second skips the rows the first holds, and
// an owner's beat that came first leaves its row fresh. It returns each row
// with the owner it had before.
func (p *PG) Take(ctx context.Context, owner string, staleAfter, expireAfter time.Duration, skip []string, limit int) ([]Row, error) {
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
		RETURNING n.id, n.cluster, n.namespace, n.pod, n.node, old.owner, n.person, n.audit, n.opened_at,
			n.released_at IS NOT NULL, n.opened_at < NOW() - make_interval(secs => $5::double precision)`,
		owner, staleAfter.Seconds(), skip, limit, expireAfter.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var person, aud []byte
		if err := rows.Scan(&r.ID, &r.Cluster, &r.Namespace, &r.Pod, &r.Node, &r.Owner, &person, &aud, &r.OpenedAt, &r.Released, &r.Expired); err != nil {
			return nil, err
		}
		r.Person, r.Audit = person, aud
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PG) Claim(ctx context.Context, id, owner string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `UPDATE node_shells SET heartbeat_at = NOW() WHERE id = $1 AND owner = $2`, id, owner)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (p *PG) Release(ctx context.Context, id, owner string) error {
	_, err := p.Pool.Exec(ctx, `UPDATE node_shells SET released_at = NOW() WHERE id = $1 AND owner = $2`, id, owner)
	return err
}

func (p *PG) Remove(ctx context.Context, id, owner string) (bool, error) {
	tag, err := p.Pool.Exec(ctx, `DELETE FROM node_shells WHERE id = $1 AND owner = $2`, id, owner)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (p *PG) Ping(ctx context.Context) error { return p.Pool.Ping(ctx) }
