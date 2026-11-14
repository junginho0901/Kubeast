"""O-27: the ai-service's session limits stay on a connection whose first use only reads, on a PostgreSQL server.

SQLAlchemy's asyncpg adapter begins a transaction at a connection's first statement, so SETs run in the pool's
"connect" event outside autocommit sit in that transaction and are undone when the session that first used the
connection only reads and is closed (a rollback). The pool holds one connection, so the second session gets the
same one.

These tests run against the server named by DBMIGRATE_TEST_DATABASE_URL (the CI dbmigrate tests' URL, also given to
the ai-service job; no table is made) and skip when it is unset.
"""
import os
import time

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app import database, db_session

RAW_URL = os.environ.get("DBMIGRATE_TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(not RAW_URL, reason="DBMIGRATE_TEST_DATABASE_URL not set: needs a PostgreSQL server")


def _asyncpg_url(raw: str) -> str:
    # postgres://user:pw@host:port/db?sslmode=disable, the Go services' form
    return "postgresql+asyncpg://" + raw.partition("://")[2]


@pytest.fixture
def one_connection(monkeypatch):
    for var, _, _ in db_session.SESSION_LIMITS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv(db_session.POOL_MAX_ENV, "1")


async def _one(session, sql: str):
    return (await session.execute(text(sql))).scalar_one()


async def test_the_limits_stay_after_a_first_use_that_only_reads(one_connection):
    svc = database.DatabaseService(_asyncpg_url(RAW_URL))
    try:
        pool = svc.engine.sync_engine.pool
        assert (pool.size(), pool._max_overflow) == (1, 0)
        async with svc.async_session() as s:
            first = await _one(s, "SELECT pg_backend_pid()")
        async with svc.async_session() as s:
            assert await _one(s, "SELECT pg_backend_pid()") == first
            got = {
                name: await _one(s, f"SHOW {name}")
                for name in ("statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout")
            }
        assert got == {"statement_timeout": "30s", "lock_timeout": "15s", "idle_in_transaction_session_timeout": "5min"}
    finally:
        await svc.engine.dispose()


async def test_a_statement_past_its_limit_is_cancelled_after_a_first_use_that_only_reads(one_connection, monkeypatch):
    monkeypatch.setenv("DB_STATEMENT_TIMEOUT_MS", "200")
    svc = database.DatabaseService(_asyncpg_url(RAW_URL))
    try:
        async with svc.async_session() as s:
            await _one(s, "SELECT 1")
        async with svc.async_session() as s:
            start = time.monotonic()
            with pytest.raises(DBAPIError) as err:
                await s.execute(text("SELECT pg_sleep(5)"))
            assert time.monotonic() - start < 3
        assert getattr(err.value.orig, "sqlstate", None) == "57014"  # query_canceled
    finally:
        await svc.engine.dispose()
