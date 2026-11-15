"""PostgreSQL session limits and pool size of the ai-service's own connections.

The same DB_* variables and defaults as the Go services (services/pkg/dbsession, the chart's
postgresql.sessionLimits), in milliseconds; 0 sets nothing, so the database's own setting applies.
They are SET on each new connection (SQLAlchemy's pool "connect" event, in autocommit so a rollback
does not undo them), not sent as startup parameters, so a pooler that refuses unknown startup
parameters (PgBouncer by default) still connects. PostgreSQL's default for each is 0 (no limit), so without them a statement that does not
end, or a transaction left open, keeps its locks and its pool connection.
"""
from __future__ import annotations

import os
from typing import Any, Callable, Mapping, Optional

# (variable, PostgreSQL parameter, default in milliseconds)
SESSION_LIMITS = (
    ("DB_STATEMENT_TIMEOUT_MS", "statement_timeout", 30_000),
    ("DB_LOCK_TIMEOUT_MS", "lock_timeout", 15_000),
    ("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "idle_in_transaction_session_timeout", 300_000),
)

# The pool size (the chart's postgresql.pool.aiService.maxConns): SQLAlchemy's default pool of 5
# plus an overflow of 10 is 15 connections.
POOL_MAX_ENV = "DB_POOL_MAX_AI"
POOL_MAX_DEFAULT = 15
POOL_KEPT = 5


def _millis(value: Optional[str], default: int) -> int:
    try:
        n = int((value or "").strip())
    except ValueError:
        return default
    return n if n >= 0 else default


def statements(environ: Optional[Mapping[str, str]] = None) -> list[str]:
    """The SET statements for the limits; an absent, negative or unreadable value keeps the default."""
    env = os.environ if environ is None else environ
    out: list[str] = []
    for var, param, default in SESSION_LIMITS:
        ms = _millis(env.get(var), default)
        if ms > 0:
            out.append(f"SET {param} = {ms}")
    return out


def pool_args(environ: Optional[Mapping[str, str]] = None) -> dict[str, int]:
    """create_async_engine's pool_size and max_overflow for DB_POOL_MAX_AI connections at most."""
    env = os.environ if environ is None else environ
    try:
        n = int((env.get(POOL_MAX_ENV) or "").strip())
    except ValueError:
        n = POOL_MAX_DEFAULT
    if n < 1 or n > 10_000:
        n = POOL_MAX_DEFAULT
    kept = min(POOL_KEPT, n)
    return {"pool_size": kept, "max_overflow": n - kept}


def on_connect(stmts: list[str]) -> Callable[[Any, Any], None]:
    """A pool "connect" listener that runs stmts on each new DBAPI connection, one statement at a time, in autocommit.

    The DBAPI connection (SQLAlchemy's asyncpg adapter) begins a transaction at its first statement, and a SET inside
    it is undone when that transaction rolls back: a first use that only reads, or the pool's reset on return, would
    leave the connection without its limits. So the SETs run outside a transaction, the way SQLAlchemy's PostgreSQL
    documentation sets search_path ("Setting Alternate Search Paths on Connect").
    """

    def run(dbapi_connection: Any, _connection_record: Any) -> None:
        autocommit = dbapi_connection.autocommit
        dbapi_connection.autocommit = True
        try:
            cursor = dbapi_connection.cursor()
            try:
                for stmt in stmts:
                    cursor.execute(stmt)
            finally:
                cursor.close()
        finally:
            dbapi_connection.autocommit = autocommit

    return run
