// Package pglock picks one process of several for a job with a PostgreSQL
// session advisory lock (pg_try_advisory_lock) held on a connection of its own,
// outside the shared pool. The lock lives as long as that connection: a process
// that stops, or whose connection breaks, gives it up and another process takes
// it at its next try. One process alone always holds it.
package pglock

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const opTimeout = 5 * time.Second

// Lock is one advisory lock key, tried and held by this process.
type Lock struct {
	key     int64
	connect func(ctx context.Context) (*pgx.Conn, error)

	mu   sync.Mutex
	conn *pgx.Conn
	held bool
}

// New makes a lock on key whose connection is made with the pool's settings.
func New(pool *pgxpool.Pool, key int64) *Lock {
	cfg := pool.Config().ConnConfig
	return &Lock{key: key, connect: func(ctx context.Context) (*pgx.Conn, error) { return pgx.ConnectConfig(ctx, cfg.Copy()) }}
}

// Held says whether this process holds the lock, taking it when it is free. A
// held lock is checked with a ping of its connection; a connection that fails
// is closed, which gives the lock up, and the next call tries again.
func (l *Lock) Held(ctx context.Context) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, opTimeout)
	defer cancel()
	if l.conn == nil || l.conn.IsClosed() {
		l.held = false
		c, err := l.connect(ctx)
		if err != nil {
			slog.Debug("pglock: connect", "key", l.key, "err", err)
			return false
		}
		l.conn = c
	}
	if l.held {
		if err := l.conn.Ping(ctx); err != nil {
			slog.Warn("pglock: lost the lock's connection", "key", l.key, "err", err)
			l.drop()
			return false
		}
		return true
	}
	var ok bool
	if err := l.conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, l.key).Scan(&ok); err != nil {
		slog.Debug("pglock: try", "key", l.key, "err", err)
		l.drop()
		return false
	}
	l.held = ok
	return ok
}

// Close gives the lock up and closes its connection.
func (l *Lock) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.drop()
}

func (l *Lock) drop() {
	if l.conn != nil {
		ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
		_ = l.conn.Close(ctx)
		cancel()
	}
	l.conn, l.held = nil, false
}
