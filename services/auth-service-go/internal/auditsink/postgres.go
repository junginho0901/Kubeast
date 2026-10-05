package auditsink

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// lockKey is the Postgres advisory lock the sending replica holds
// (arbitrary constant: "kubeast-audit-sinks").
const lockKey int64 = 0x6b62617564736e6b

// PG is the Store and Locker over the shared database.
type PG struct{ Pool *pgxpool.Pool }

func (p PG) EnsureCursor(ctx context.Context, sink string, start int64) (int64, error) {
	if _, err := p.Pool.Exec(ctx,
		`INSERT INTO audit_sink_cursors (sink_name, last_id) VALUES ($1, $2) ON CONFLICT (sink_name) DO NOTHING`, sink, start); err != nil {
		return 0, err
	}
	var id int64
	err := p.Pool.QueryRow(ctx, `SELECT last_id FROM audit_sink_cursors WHERE sink_name = $1`, sink).Scan(&id)
	return id, err
}

func (p PG) MaxID(ctx context.Context) (int64, error) {
	var id int64
	err := p.Pool.QueryRow(ctx, `SELECT COALESCE(MAX(id), 0) FROM auth_audit_logs`).Scan(&id)
	return id, err
}

func (p PG) After(ctx context.Context, after int64, limit int, settle time.Duration) ([]Event, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id, created_at, COALESCE(service, ''), action, result, COALESCE(error, ''),
		       COALESCE(actor_user_id, ''), COALESCE(actor_email, ''), COALESCE(target_type, ''),
		       COALESCE(target_id, ''), COALESCE(target_email, ''), COALESCE(cluster, ''),
		       COALESCE(namespace, ''), COALESCE(path, ''), COALESCE(request_ip, ''),
		       COALESCE(user_agent, ''), COALESCE(request_id, ''), before, after
		  FROM auth_audit_logs
		 WHERE id > $1 AND created_at < NOW() - make_interval(secs => $2)
		 ORDER BY id
		 LIMIT $3`, after, settle.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var before, after []byte
		if err := rows.Scan(&e.ID, &e.Time, &e.Service, &e.Action, &e.Result, &e.Error,
			&e.ActorUserID, &e.ActorEmail, &e.TargetType, &e.TargetID, &e.TargetEmail, &e.Cluster,
			&e.Namespace, &e.Path, &e.RequestIP, &e.UserAgent, &e.RequestID, &before, &after); err != nil {
			return nil, err
		}
		e.Before, e.After = jsonOrNil(before), jsonOrNil(after)
		out = append(out, e)
	}
	return out, rows.Err()
}

func jsonOrNil(b []byte) []byte {
	if s := string(b); s == "" || s == "{}" || s == "null" {
		return nil
	}
	return b
}

func (p PG) Advance(ctx context.Context, sink string, id int64) error {
	_, err := p.Pool.Exec(ctx,
		`UPDATE audit_sink_cursors SET last_id = $2, last_sent_at = NOW(), failures = 0, updated_at = NOW() WHERE sink_name = $1 AND last_id < $2`, sink, id)
	return err
}

func (p PG) Fail(ctx context.Context, sink, msg string) error {
	if len(msg) > 1000 {
		msg = msg[:1000]
	}
	_, err := p.Pool.Exec(ctx,
		`UPDATE audit_sink_cursors SET failures = failures + 1, last_error = $2, last_error_at = NOW(), updated_at = NOW() WHERE sink_name = $1`, sink, msg)
	return err
}

// TryLock takes the advisory lock on a dedicated connection and watches it;
// the lock lives as long as that connection.
func (p PG) TryLock(ctx context.Context) (func(), <-chan struct{}, bool, error) {
	conn, err := p.Pool.Acquire(ctx)
	if err != nil {
		return nil, nil, false, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey).Scan(&ok); err != nil || !ok {
		conn.Release()
		return nil, nil, false, err
	}
	lost := make(chan struct{})
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				pctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := conn.Ping(pctx)
				cancel()
				if err != nil {
					close(lost)
					return
				}
			}
		}
	}()
	var once bool
	release := func() {
		if once {
			return
		}
		once = true
		close(stop)
		uctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _ = conn.Exec(uctx, `SELECT pg_advisory_unlock($1)`, lockKey)
		cancel()
		conn.Release()
	}
	return release, lost, true, nil
}

// Floor is the highest audit id every configured sink has handled — what
// retention may delete up to. A configured sink without a cursor yet makes
// the floor 0 (delete nothing).
func Floor(ctx context.Context, pool *pgxpool.Pool, sinks []string) (int64, error) {
	if len(sinks) == 0 {
		return 0, errors.New("no sinks")
	}
	var n int
	var floor int64
	err := pool.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(MIN(last_id), 0) FROM audit_sink_cursors WHERE sink_name = ANY($1)`, sinks).Scan(&n, &floor)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	if n < len(sinks) {
		return 0, nil
	}
	return floor, nil
}
