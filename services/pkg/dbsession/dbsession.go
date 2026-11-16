// Package dbsession holds the PostgreSQL session limits the Go services put on the connections they open:
// statement_timeout, lock_timeout and idle_in_transaction_session_timeout, set with SET statements once a connection
// is made (pgconn's AfterConnect), not as startup parameters, so a pooler that refuses unknown startup parameters
// (PgBouncer by default) still connects. PostgreSQL's default for each is 0 (no limit), so a statement that does not
// end, or a transaction left open, keeps its locks and its pool connection until the process goes. A request's
// context ending does not stop its statement on the server: pgx closes the connection without a cancel request.
//
// The values come from the DB_* variables (the chart's postgresql.sessionLimits). 0 sets nothing, so the database's
// own setting (server, database or role) applies. Behind RDS Proxy a SET pins the client connection to one database
// connection; there the limits go to the proxy's initialization query or the role, and the variables to 0.
//
// The advisory-lock connections (audit sinks) sit idle outside a transaction and run short statements, so these
// limits leave them alone; idle_session_timeout, which would close them, is never set. Schema migrations run
// without the statement and lock limits, also when the role or the database sets them (ApplyMigrations).
package dbsession

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

// The variables, in milliseconds; 0 = not set.
const (
	EnvStatementTimeout  = "DB_STATEMENT_TIMEOUT_MS"
	EnvLockTimeout       = "DB_LOCK_TIMEOUT_MS"
	EnvIdleInTransaction = "DB_IDLE_IN_TRANSACTION_TIMEOUT_MS"
)

// The PostgreSQL parameter names.
const (
	ParamStatementTimeout  = "statement_timeout"
	ParamLockTimeout       = "lock_timeout"
	ParamIdleInTransaction = "idle_in_transaction_session_timeout"
)

// MigrationPoolMaxConns is the size of the pool the schema migrations run through: goose works on one connection,
// which holds its session lock.
const MigrationPoolMaxConns = 4

// Limits are the session limits of one pool. A zero field is not set.
type Limits struct {
	StatementTimeout  time.Duration
	LockTimeout       time.Duration
	IdleInTransaction time.Duration
}

// Defaults apply when a variable is absent or unreadable; the chart's defaults are the same. The statement limit
// matches the 30 s the HTTP handlers of auth-service and session-service get, the lock limit is below it so a
// lock wait fails with its own error first, and five minutes idle inside a transaction is far past any gap
// between two statements of one transaction in the services.
var Defaults = Limits{
	StatementTimeout:  30 * time.Second,
	LockTimeout:       15 * time.Second,
	IdleInTransaction: 5 * time.Minute,
}

// FromEnv reads the limits from the DB_* variables. An absent, negative or unreadable value keeps the default.
func FromEnv() Limits {
	return Limits{
		StatementTimeout:  envMillis(EnvStatementTimeout, Defaults.StatementTimeout),
		LockTimeout:       envMillis(EnvLockTimeout, Defaults.LockTimeout),
		IdleInTransaction: envMillis(EnvIdleInTransaction, Defaults.IdleInTransaction),
	}
}

func envMillis(key string, def time.Duration) time.Duration {
	ms := config.GetEnvInt(key, -1)
	if ms < 0 {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}

// PoolMaxConns reads a pool size from key: a whole number of 1 or more, else def.
func PoolMaxConns(key string, def int32) int32 {
	n := config.GetEnvInt(key, 0)
	if n < 1 || n > 10_000 {
		return def
	}
	return int32(n)
}

// Statements is the SET statements for the limits, in one string; a zero limit has none, and no limit gives "".
func (l Limits) Statements() string {
	var s []string
	s = appendSet(s, ParamStatementTimeout, l.StatementTimeout)
	s = appendSet(s, ParamLockTimeout, l.LockTimeout)
	s = appendSet(s, ParamIdleInTransaction, l.IdleInTransaction)
	return strings.Join(s, "; ")
}

// MigrationStatements is Statements for the connections that run the schema migrations. A migration may rewrite a
// large table and waits for its table locks, so statement_timeout and lock_timeout are always set to 0 (none), over
// any role or database setting, whatever l holds: with the variables at 0 and the limits on the role (behind RDS
// Proxy), the migrations would otherwise run under the role's limits. idle_in_transaction_session_timeout is l's.
func (l Limits) MigrationStatements() string {
	s := []string{"SET " + ParamStatementTimeout + " = 0", "SET " + ParamLockTimeout + " = 0"}
	s = appendSet(s, ParamIdleInTransaction, l.IdleInTransaction)
	return strings.Join(s, "; ")
}

// Apply makes every connection made with cfg run Statements once it is connected.
func (l Limits) Apply(cfg *pgconn.Config) { runAfterConnect(cfg, l.Statements()) }

// ApplyMigrations makes every connection made with cfg run MigrationStatements once it is connected.
func (l Limits) ApplyMigrations(cfg *pgconn.Config) { runAfterConnect(cfg, l.MigrationStatements()) }

func appendSet(s []string, name string, d time.Duration) []string {
	if ms := d.Milliseconds(); ms > 0 {
		s = append(s, fmt.Sprintf("SET %s = %d", name, ms))
	}
	return s
}

// runAfterConnect runs stmts on each new connection, after the AfterConnect cfg already had. A failure fails the
// connection attempt, so no connection goes into a pool without its limits.
func runAfterConnect(cfg *pgconn.Config, stmts string) {
	if stmts == "" {
		return
	}
	prev := cfg.AfterConnect
	cfg.AfterConnect = func(ctx context.Context, conn *pgconn.PgConn) error {
		if prev != nil {
			if err := prev(ctx, conn); err != nil {
				return err
			}
		}
		if _, err := conn.Exec(ctx, stmts).ReadAll(); err != nil {
			return fmt.Errorf("dbsession: %s: %w", stmts, err)
		}
		return nil
	}
}
