// Package pglock picks one process of several for a job with a PostgreSQL
// session advisory lock (pg_try_advisory_lock) held on a connection of its own,
// outside the shared pool. The lock lives as long as that connection: a process
// that stops, or whose connection breaks, gives it up and another process takes
// it at its next try. One process alone always holds it.
//
// Both ends of the connection send TCP keepalives after 10 s without traffic,
// every 5 s, and drop it after 3 go unanswered, so a holder whose node is gone
// loses the lock in about 25 s, not after the operating system's two hours.
package pglock

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const opTimeout = 5 * time.Second

// keepalive is the client side's; keepaliveSQL sets the server's for this
// session (PostgreSQL ignores them on a Unix socket).
var keepalive = net.KeepAliveConfig{Enable: true, Idle: 10 * time.Second, Interval: 5 * time.Second, Count: 3}

const keepaliveSQL = `SELECT set_config('tcp_keepalives_idle', '10', false), set_config('tcp_keepalives_interval', '5', false),
	set_config('tcp_keepalives_count', '3', false)`

// Lock is one advisory lock key, tried and held by this process.
type Lock struct {
	key     int64
	connect func(ctx context.Context) (*pgx.Conn, error)

	mu   sync.Mutex
	conn *pgx.Conn
	held bool
}

// New makes a lock on key whose connection is made with the pool's settings
// and the keepalives above.
func New(pool *pgxpool.Pool, key int64) *Lock {
	cfg := pool.Config().ConnConfig.Copy()
	cfg.DialFunc = (&net.Dialer{Timeout: cfg.ConnectTimeout, KeepAliveConfig: keepalive}).DialContext
	return &Lock{key: key, connect: func(ctx context.Context) (*pgx.Conn, error) {
		c, err := pgx.ConnectConfig(ctx, cfg.Copy())
		if err != nil {
			return nil, err
		}
		// Without them the lock still works; a holder that vanished is only noticed later.
		if _, err := c.Exec(ctx, keepaliveSQL); err != nil {
			slog.Warn("pglock: server keepalives not set", "key", key, "err", err)
		}
		return c, nil
	}}
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
