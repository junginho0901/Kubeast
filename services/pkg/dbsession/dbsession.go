// Package dbsession holds the PostgreSQL session limits the Go services put on the connections they open:
// statement_timeout, lock_timeout and idle_in_transaction_session_timeout, sent as run-time parameters when a
// connection starts. PostgreSQL's default for each is 0 (no limit), so a statement that does not end, or a
// transaction left open, keeps its locks and its pool connection until the process goes. A request's context
// ending does not stop its statement on the server: pgx closes the connection without a cancel request.
//
// The values come from the DB_* variables (the chart's postgresql.sessionLimits). 0 sends nothing, so the
// database's own setting (server, database, role, or a parameter in DATABASE_URL) applies; that is also the
// setting for a connection pooler that refuses unknown startup parameters.
//
// The advisory-lock connections (audit sinks) sit idle outside a transaction and run short statements, so these
// limits leave them alone; idle_session_timeout, which would close them, is never set. Schema migrations run
// without the statement and lock limits (ApplyMigrations).
package dbsession

import (
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/junginho0901/kubeast/services/pkg/config"
)

// The variables, in milliseconds; 0 = not sent.
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

// Limits are the session limits of one pool. A zero field is not sent.
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

// Apply sets the limits on cfg's run-time parameters. A zero limit leaves the parameter as it is: absent, or the
// value DATABASE_URL gave.
func (l Limits) Apply(cfg *pgconn.Config) {
	set(cfg, ParamStatementTimeout, l.StatementTimeout)
	set(cfg, ParamLockTimeout, l.LockTimeout)
	set(cfg, ParamIdleInTransaction, l.IdleInTransaction)
}

// ApplyMigrations is Apply for the connections that run the schema migrations. A migration may rewrite a large
// table and waits for its table locks, so statement_timeout and lock_timeout are sent as 0 (none), over any role
// or database setting, wherever l sets them for the other connections; where l leaves one unset, nothing is
// sent. idle_in_transaction_session_timeout is l's.
func (l Limits) ApplyMigrations(cfg *pgconn.Config) {
	if l.StatementTimeout > 0 {
		setRaw(cfg, ParamStatementTimeout, "0")
	}
	if l.LockTimeout > 0 {
		setRaw(cfg, ParamLockTimeout, "0")
	}
	set(cfg, ParamIdleInTransaction, l.IdleInTransaction)
}

func set(cfg *pgconn.Config, name string, d time.Duration) {
	if ms := d.Milliseconds(); ms > 0 {
		setRaw(cfg, name, strconv.FormatInt(ms, 10))
	}
}

func setRaw(cfg *pgconn.Config, name, value string) {
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams[name] = value
}
