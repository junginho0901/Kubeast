"""PostgreSQL session limits the ai-service sets on its own connections.

The same DB_* variables and defaults as the Go services (services/pkg/dbsession, the chart's
postgresql.sessionLimits), in milliseconds; 0 sends nothing, so the database's own setting applies.
asyncpg sends them as server settings when a connection starts. PostgreSQL's default for each is 0
(no limit), so without them a statement that does not end, or a transaction left open, keeps its
locks and its pool connection.
"""
from __future__ import annotations

import os
from typing import Mapping, Optional

# (variable, PostgreSQL parameter, default in milliseconds)
SESSION_LIMITS = (
    ("DB_STATEMENT_TIMEOUT_MS", "statement_timeout", 30_000),
    ("DB_LOCK_TIMEOUT_MS", "lock_timeout", 15_000),
    ("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "idle_in_transaction_session_timeout", 300_000),
)


def _millis(value: Optional[str], default: int) -> int:
    try:
        n = int((value or "").strip())
    except ValueError:
        return default
    return n if n >= 0 else default


def server_settings(environ: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """The limits as asyncpg ``server_settings``; an absent, negative or unreadable value keeps the default."""
    env = os.environ if environ is None else environ
    out: dict[str, str] = {}
    for var, param, default in SESSION_LIMITS:
        ms = _millis(env.get(var), default)
        if ms > 0:
            out[param] = str(ms)
    return out
